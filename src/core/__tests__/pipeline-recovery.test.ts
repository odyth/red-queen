import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedQueenDatabase } from "../database.js";
import type { AuditLogger } from "../audit.js";
import { PipelineStateStore } from "../pipeline-state.js";
import { SqliteTaskQueue } from "../queue.js";
import { buildPhaseGraph } from "../config.js";
import { DEFAULT_PHASES } from "../defaults.js";
import { RuntimeState } from "../runtime-state.js";
import { resumePipeline } from "../pipeline-recovery.js";
import { retryPhaseTransition } from "../phase-transition.js";
import { reconcile } from "../reconciler.js";
import { routeAiAssignment } from "../assignment-router.js";
import { makeTestConfig } from "./fixtures/test-config.js";
import { MockIssueTracker, makeIssue } from "./fixtures/mock-adapters.js";

function setup() {
  const db = new RedQueenDatabase(":memory:");
  const pipelineState = new PipelineStateStore(db.db);
  const queue = new SqliteTaskQueue(db.db);
  const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
  const runtime = new RuntimeState(phaseGraph, makeTestConfig());
  const issueTracker = new MockIssueTracker();
  const audit = { log: vi.fn<AuditLogger["log"]>(), query: () => [], prune: () => 0 };
  pipelineState.create("PROJ-1", "coding", "human-1");
  issueTracker.phases.set("PROJ-1", "coding");
  pipelineState.setExhaustedPhase("PROJ-1", "coding");
  return { db, pipelineState, queue, phaseGraph, runtime, issueTracker, audit };
}

describe("durable pipeline recovery", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => {
    vi.useRealTimers();
    h.db.close();
  });

  it("resumes once, reassigns to AI, and revalidates the assignment at dispatch", async () => {
    h.pipelineState.incrementPhaseReworks("PROJ-1", "testing");
    const assign = h.issueTracker.assignToAi.bind(h.issueTracker);
    vi.spyOn(h.issueTracker, "assignToAi").mockImplementation((issueId) => {
      expect(h.queue.listByStatus("ready")).toMatchObject([
        { type: "coding", metadata: { requiresAiAssignment: true } },
      ]);
      expect(h.pipelineState.isPhaseExhausted(issueId, "coding")).toBe(false);
      return assign(issueId);
    });
    const task = await resumePipeline(h, "PROJ-1");
    expect(task).toMatchObject({ type: "coding", metadata: { requiresAiAssignment: true } });
    expect(h.issueTracker.assignments.get("PROJ-1")).toBe("ai");
    expect(h.pipelineState.isPhaseExhausted("PROJ-1", "coding")).toBe(false);
    expect(h.pipelineState.incrementPhaseReworks("PROJ-1", "testing")).toBe(1);
    await expect(resumePipeline(h, "PROJ-1")).rejects.toThrow("not exhausted");
    expect(h.queue.listByStatus("ready")).toHaveLength(1);
  });

  it.each(["blocked", "done", "unknown", null])("refuses resume in %s", async (phase) => {
    h.issueTracker.phases.set("PROJ-1", phase);
    await expect(resumePipeline(h, "PROJ-1")).rejects.toThrow("open ticket");
    expect(h.queue.listByStatus("ready")).toHaveLength(0);
    expect(h.pipelineState.isPhaseExhausted("PROJ-1", "coding")).toBe(true);
  });

  it("refuses closed tickets, pending handoffs, and open work", async () => {
    h.issueTracker.closedIssues.add("PROJ-1");
    await expect(resumePipeline(h, "PROJ-1")).rejects.toThrow("open ticket");
    h.issueTracker.closedIssues.clear();
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "blocked");
    await expect(resumePipeline(h, "PROJ-1")).rejects.toThrow("pending");
    h.pipelineState.finishPhaseTransition("PROJ-1", "coding", () => undefined);
    h.pipelineState.setExhaustedPhase("PROJ-1", "coding");
    h.queue.enqueue({ type: "testing", issueId: "PROJ-1" });
    await expect(resumePipeline(h, "PROJ-1")).rejects.toThrow("open task");
  });

  it("rolls back the resume and counters if enqueue fails", async () => {
    h.pipelineState.incrementPhaseReworks("PROJ-1", "testing");
    h.issueTracker.assignments.set("PROJ-1", "human");
    vi.spyOn(h.queue, "enqueue").mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(resumePipeline(h, "PROJ-1")).rejects.toThrow("disk full");
    expect(h.pipelineState.isPhaseExhausted("PROJ-1", "coding")).toBe(true);
    expect(h.pipelineState.incrementPhaseReworks("PROJ-1", "testing")).toBe(2);
    expect(h.issueTracker.assignments.get("PROJ-1")).toBe("human");
    expect(h.issueTracker.calls).not.toContain("assignToAi:PROJ-1");
    expect(h.queue.listByStatus("ready")).toHaveLength(0);
  });

  it("retains a guarded resume task and recovery instructions when reassignment fails", async () => {
    vi.spyOn(h.issueTracker, "assignToAi").mockRejectedValue(new Error("denied"));
    await expect(resumePipeline(h, "PROJ-1")).rejects.toThrow(
      "was saved, but AI assignment failed: denied. Assign this ticket to AI manually",
    );
    expect(h.pipelineState.isPhaseExhausted("PROJ-1", "coding")).toBe(false);
    expect(h.queue.listByStatus("ready")).toMatchObject([
      { type: "coding", metadata: { requiresAiAssignment: true } },
    ]);
    await expect(resumePipeline(h, "PROJ-1")).rejects.toThrow("not exhausted");
    expect(h.queue.listByStatus("ready")).toHaveLength(1);
  });

  it.each([
    { status: "ready", legacy: false },
    { status: "deferred", legacy: false },
    { status: "ready", legacy: true },
    { status: "deferred", legacy: true },
  ])(
    "resumes a stopped handoff with $status feedback (legacy=$legacy)",
    async ({ status, legacy }) => {
      vi.useFakeTimers();
      h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "code-review");
      const assign = vi.spyOn(h.issueTracker, "assignToAi").mockRejectedValue(new Error("denied"));
      await retryPhaseTransition(h, "PROJ-1");
      vi.advanceTimersByTime(300_000);
      await retryPhaseTransition(h, "PROJ-1");
      vi.advanceTimersByTime(600_000);
      expect(await retryPhaseTransition(h, "PROJ-1")).toBe("assignment-stopped");
      const feedback = h.queue.enqueue({
        type: "code-feedback",
        issueId: "PROJ-1",
        description: legacy ? "PR feedback" : undefined,
        metadata: legacy ? undefined : { trigger: "pr-feedback" },
      });
      if (status === "deferred") {
        h.queue.markDeferred(feedback.id, ["<pending-transition>"]);
      }
      assign.mockRestore();

      const task = await resumePipeline(h, "PROJ-1");

      expect(task).toMatchObject({ type: "code-review", metadata: { requiresAiAssignment: true } });
      expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
      expect(h.queue.getTask(feedback.id)).toMatchObject({ status, metadata: feedback.metadata });
      expect(h.issueTracker.assignments.get("PROJ-1")).toBe("ai");
      expect(h.issueTracker.calls.filter((call) => call.startsWith("setPhase:"))).toHaveLength(1);
    },
  );

  it.each([
    { status: "ready", type: "coding" },
    { status: "deferred", type: "coding" },
    { status: "working", type: "code-feedback" },
  ])("refuses conflicting $status $type feedback", async ({ status, type }) => {
    const feedback = h.queue.enqueue({
      type,
      issueId: "PROJ-1",
      metadata: { trigger: "pr-feedback" },
    });
    if (status === "deferred") {
      h.queue.markDeferred(feedback.id, ["<pending-transition>"]);
    } else if (status === "working") {
      h.queue.markWorking(feedback.id);
    }

    await expect(resumePipeline(h, "PROJ-1")).rejects.toThrow("already has an open task");

    expect(h.queue.getTask(feedback.id)?.status).toBe(status);
    expect(h.pipelineState.isPhaseExhausted("PROJ-1", "coding")).toBe(true);
    expect(h.issueTracker.calls).not.toContain("assignToAi:PROJ-1");
  });

  it("observes a stopped ticket at a human gate before polling its re-entry", async () => {
    h.issueTracker.phases.set("PROJ-1", "blocked");
    await reconcile(h);
    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("blocked");
    expect(h.pipelineState.isPhaseExhausted("PROJ-1", "coding")).toBe(false);
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);
    expect((await reconcile(h)).tasksCreated).toBe(1);
  });

  it("keeps an unobserved gate round trip stopped and emits no per-ticket skip spam", async () => {
    h.issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);
    for (let i = 0; i < 3; i++) {
      expect((await reconcile(h)).tasksCreated).toBe(0);
    }
    expect(h.audit.log.mock.calls.filter(([entry]) => entry.issueId === "PROJ-1")).toHaveLength(0);
  });

  it("does not overwrite a resume that completes while the gate read is in flight", async () => {
    vi.spyOn(h.issueTracker, "getPhase").mockImplementation(() => {
      h.pipelineState.setExhaustedPhase("PROJ-1", null);
      return Promise.resolve("blocked");
    });
    await reconcile(h);
    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("coding");
  });

  it("allows explicit same-phase assignment to re-enter but passive recovery stays stopped", async () => {
    h.issueTracker.assignments.set("PROJ-1", "ai");
    const options = { issueId: "PROJ-1", component: "test", description: "Assigned to AI" };
    expect((await routeAiAssignment(h, options)).outcome).toBe("skipped");
    expect((await routeAiAssignment(h, { ...options, explicitReentry: true })).outcome).toBe(
      "enqueued",
    );
    expect((await routeAiAssignment(h, { ...options, explicitReentry: true })).outcome).toBe(
      "skipped",
    );
  });

  it("retains a failed phase write and later retries the handoff alone", async () => {
    vi.useFakeTimers();
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "blocked");
    h.issueTracker.setPhaseFailures.add("blocked");
    await retryPhaseTransition(h, "PROJ-1");
    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("coding");
    expect(h.pipelineState.isPhaseExhausted("PROJ-1", "coding")).toBe(true);
    expect(h.issueTracker.assignments.has("PROJ-1")).toBe(false);
    h.issueTracker.setPhaseFailures.clear();
    vi.advanceTimersByTime(300_000);
    await reconcile(h);
    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("blocked");
    expect(h.issueTracker.assignments.get("PROJ-1")).toBe("human");
    expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
    expect(h.queue.listByStatus("ready")).toHaveLength(0);
  });

  it("backs off phase writes up to an hour, posts one notice, and eventually recovers", async () => {
    vi.useFakeTimers();
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "code-review");
    h.issueTracker.setPhaseFailures.add("code-review");
    const writes = vi.spyOn(h.issueTracker, "setPhase");
    const delays = [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000];
    for (const [index, delay] of delays.entries()) {
      expect(await retryPhaseTransition(h, "PROJ-1")).toBe("phase-pending");
      expect(writes).toHaveBeenCalledTimes(index + 1);
      expect(h.pipelineState.getPendingTransition("PROJ-1")).toMatchObject({
        phaseAttempts: index + 1,
        phaseRetryAt: Date.now() + delay,
        phaseNoticePosted: index < 2 ? 0 : 1,
      });
      expect(h.issueTracker.commentsById.get("PROJ-1") ?? []).toHaveLength(index < 2 ? 0 : 1);
      const auditCount = h.audit.log.mock.calls.length;
      vi.advanceTimersByTime(delay - 1);
      await reconcile(h);
      expect(writes).toHaveBeenCalledTimes(index + 1);
      expect(h.queue.getOpenCount()).toEqual({ ready: 0, working: 0, deferred: 0 });
      // Only the sweep's summary was logged; waiting does not repeat failure logs.
      expect(h.audit.log.mock.calls.length).toBe(auditCount + 1);
      vi.advanceTimersByTime(1);
    }
    expect(h.issueTracker.commentsById.get("PROJ-1")?.[0]?.body).toContain("after 3 attempts");
    expect(h.issueTracker.commentsById.get("PROJ-1")?.[0]?.body).toContain(
      "No worker is restarted",
    );
    h.issueTracker.setPhaseFailures.clear();
    await reconcile(h);
    expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
    expect(h.queue.listByStatus("ready")).toHaveLength(1);
    expect(h.queue.dequeue()?.type).toBe("code-review");
    expect(h.issueTracker.commentsById.get("PROJ-1")).toHaveLength(1);
  });

  it("retries an undelivered persistent phase failure notice on the next backed-off attempt", async () => {
    vi.useFakeTimers();
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "blocked");
    h.issueTracker.setPhaseFailures.add("blocked");
    const post = vi.spyOn(h.issueTracker, "addComment").mockRejectedValueOnce(new Error("offline"));
    await retryPhaseTransition(h, "PROJ-1");
    vi.advanceTimersByTime(300_000);
    await retryPhaseTransition(h, "PROJ-1");
    vi.advanceTimersByTime(600_000);
    await retryPhaseTransition(h, "PROJ-1");
    expect(post).toHaveBeenCalledTimes(1);
    expect(h.pipelineState.getPendingTransition("PROJ-1")?.phaseNoticePosted).toBe(0);
    await retryPhaseTransition(h, "PROJ-1");
    expect(post).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_200_000);
    await retryPhaseTransition(h, "PROJ-1");
    expect(post).toHaveBeenCalledTimes(2);
    expect(h.pipelineState.getPendingTransition("PROJ-1")?.phaseNoticePosted).toBe(1);
  });

  it("observes a manual move during phase backoff without another phase write", async () => {
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "blocked");
    h.issueTracker.setPhaseFailures.add("blocked");
    await retryPhaseTransition(h, "PROJ-1");
    h.issueTracker.phases.set("PROJ-1", "spec-review");
    expect(await retryPhaseTransition(h, "PROJ-1")).toBe("cancelled");
    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("spec-review");
    expect(h.issueTracker.calls.filter((call) => call.startsWith("setPhase:"))).toHaveLength(1);
    expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
  });

  it("preserves feedback arriving during the assignment request and cancels stale work", async () => {
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "human-review");
    const stale = h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });
    vi.spyOn(h.issueTracker, "assignToHuman").mockImplementation(() => {
      h.queue.enqueue({
        type: "code-feedback",
        issueId: "PROJ-1",
        metadata: { trigger: "pr-feedback" },
      });
      return Promise.resolve();
    });
    expect(await retryPhaseTransition(h, "PROJ-1")).toBe("completed");
    expect(h.queue.getTask(stale.id)?.status).toBe("cancelled");
    expect(h.queue.listByStatus("ready").map((task) => task.type)).toEqual(["code-feedback"]);
  });

  it("preserves queued feedback when a pending AI assignment is recovered by webhook", async () => {
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "code-review");
    vi.spyOn(h.issueTracker, "assignToAi").mockRejectedValue(new Error("denied"));
    await retryPhaseTransition(h, "PROJ-1");
    const feedback = h.queue.enqueue({
      type: "code-feedback",
      issueId: "PROJ-1",
      description: "PR feedback",
    });
    h.issueTracker.assignments.set("PROJ-1", "ai");
    await routeAiAssignment(h, { issueId: "PROJ-1", component: "test", description: "Assigned" });
    expect(h.queue.getTask(feedback.id)?.status).toBe("ready");
    expect(h.queue.hasOpenTask("PROJ-1", "code-review")).toBe(true);
  });

  it("retries assignment separately after a successful phase write", async () => {
    vi.useFakeTimers();
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "blocked");
    h.issueTracker.assignToHumanFailures.add("PROJ-1");
    await retryPhaseTransition(h, "PROJ-1");
    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("blocked");
    expect(h.pipelineState.getPendingTransition("PROJ-1")).not.toBeNull();
    h.issueTracker.assignToHumanFailures.clear();
    vi.advanceTimersByTime(300_000);
    await retryPhaseTransition(h, "PROJ-1");
    expect(h.issueTracker.calls.filter((call) => call === "setPhase:PROJ-1:blocked")).toHaveLength(
      1,
    );
    expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
    expect(h.issueTracker.calls).toContain("assignToHuman:PROJ-1:human-1");
  });

  it("does not replay a pending transition over a different human gate", async () => {
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "blocked");
    h.issueTracker.phases.set("PROJ-1", "human-review");
    await retryPhaseTransition(h, "PROJ-1");
    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("human-review");
    expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
    expect(h.issueTracker.calls.some((call) => call.startsWith("setPhase:"))).toBe(false);
    expect(h.queue.listByStatus("ready")).toHaveLength(0);
  });

  it("serializes simultaneous handoff recovery and enqueues its destination once", async () => {
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "code-review");
    await Promise.all([retryPhaseTransition(h, "PROJ-1"), retryPhaseTransition(h, "PROJ-1")]);
    expect(h.queue.listByStatus("ready")).toHaveLength(1);
    expect(
      h.issueTracker.calls.filter((call) => call === "setPhase:PROJ-1:code-review"),
    ).toHaveLength(1);
  });

  it("holds automated destination discovery until its assignment succeeds", async () => {
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "code-review");
    vi.spyOn(h.issueTracker, "assignToAi").mockRejectedValue(new Error("denied"));
    h.issueTracker.listByPhaseResults.set("code-review", [makeIssue("PROJ-1", "code-review")]);
    await reconcile(h);
    expect(h.issueTracker.phases.get("PROJ-1")).toBe("code-review");
    expect(h.queue.listByStatus("ready")).toHaveLength(0);
    expect(h.pipelineState.getPendingTransition("PROJ-1")).not.toBeNull();
    h.issueTracker.assignments.set("PROJ-1", "ai");
    expect(
      (
        await routeAiAssignment(h, {
          issueId: "PROJ-1",
          component: "test",
          description: "Assigned",
          explicitReentry: true,
        })
      ).reason,
    ).toBe("enqueued");
    expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
    expect(h.queue.listByStatus("ready")[0]?.metadata.requiresAiAssignment).toBe(true);
  });

  it("respects a human return to the source after the destination was confirmed", async () => {
    h.pipelineState.incrementReviewIterations("PROJ-1");
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "blocked");
    h.issueTracker.assignToHumanFailures.add("PROJ-1");
    await retryPhaseTransition(h, "PROJ-1");
    expect(h.pipelineState.getPendingTransition("PROJ-1")?.phaseApplied).toBe(1);
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);
    await reconcile(h);
    expect(h.issueTracker.phases.get("PROJ-1")).toBe("coding");
    expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
    expect(h.pipelineState.get("PROJ-1")?.reviewIterations).toBe(0);
    expect(h.queue.listByStatus("ready")).toHaveLength(1);
    expect(h.issueTracker.calls.filter((call) => call === "setPhase:PROJ-1:blocked")).toHaveLength(
      1,
    );
  });

  it.each(["blocked", "code-review"])(
    "bounds and reports failed assignment to %s",
    async (destination) => {
      vi.useFakeTimers();
      h.pipelineState.beginPhaseTransition("PROJ-1", "coding", destination);
      const assign =
        destination === "blocked"
          ? vi.spyOn(h.issueTracker, "assignToHuman")
          : vi.spyOn(h.issueTracker, "assignToAi");
      assign.mockRejectedValue(new Error("assignment denied"));
      await retryPhaseTransition(h, "PROJ-1");
      expect(assign).toHaveBeenCalledTimes(1);
      expect(h.issueTracker.commentsById.get("PROJ-1")).toHaveLength(1);
      const auditCount = h.audit.log.mock.calls.length;
      await retryPhaseTransition(h, "PROJ-1");
      expect(assign).toHaveBeenCalledTimes(1);
      expect(h.audit.log.mock.calls).toHaveLength(auditCount);
      vi.advanceTimersByTime(300_000);
      await retryPhaseTransition(h, "PROJ-1");
      expect(assign).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(300_000);
      await retryPhaseTransition(h, "PROJ-1");
      expect(assign).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(300_000);
      expect(await retryPhaseTransition(h, "PROJ-1")).toBe("assignment-stopped");
      expect(assign).toHaveBeenCalledTimes(3);
      expect(h.issueTracker.commentsById.get("PROJ-1")).toHaveLength(2);
      expect(h.issueTracker.commentsById.get("PROJ-1")?.[1]?.body).toContain(
        "stopped after 3 attempts",
      );
      if (destination === "code-review") {
        const notice = h.issueTracker.commentsById.get("PROJ-1")?.[1]?.body;
        expect(notice).toContain("redqueen pipeline resume PROJ-1");
        expect(notice).toContain("when assignment webhooks are enabled and delivered");
        expect(notice).toContain("Polling-only deployments must use `pipeline resume`");
      }
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(86_400_000);
        await retryPhaseTransition(h, "PROJ-1");
      }
      expect(assign).toHaveBeenCalledTimes(3);
      expect(h.queue.listByStatus("ready")).toHaveLength(0);
      expect(h.issueTracker.calls.filter((call) => call.startsWith("setPhase:"))).toHaveLength(1);
      if (destination === "code-review") {
        expect(h.pipelineState.isPhaseExhausted("PROJ-1", destination)).toBe(true);
        assign.mockRestore();
        await resumePipeline(h, "PROJ-1");
        expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
        expect(h.queue.listByStatus("ready")).toHaveLength(1);
      } else {
        expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
      }
    },
  );

  it("permits explicit resume during assignment recovery without another phase write", async () => {
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "code-review");
    const assign = vi.spyOn(h.issueTracker, "assignToAi").mockRejectedValue(new Error("denied"));
    await retryPhaseTransition(h, "PROJ-1");
    assign.mockRestore();
    await resumePipeline(h, "PROJ-1");
    expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
    expect(h.queue.listByStatus("ready")[0]?.metadata.requiresAiAssignment).toBe(true);
    expect(h.issueTracker.calls.filter((call) => call.startsWith("setPhase:"))).toHaveLength(1);
  });

  it("cancels a removed destination before resolving it in the phase graph", async () => {
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "blocked");
    h.runtime.phaseGraph = buildPhaseGraph(
      DEFAULT_PHASES.filter((phase) => phase.name !== "blocked").map((phase) =>
        phase.escalateTo === "blocked" ? { ...phase, escalateTo: "human-review" } : phase,
      ),
    );
    h.issueTracker.phases.set("PROJ-1", "spec-review");
    expect(await retryPhaseTransition(h, "PROJ-1")).toBe("cancelled");
    expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("spec-review");
  });

  it("does not finish a replacement handoff when an older assignment returns", async () => {
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "blocked");
    vi.spyOn(h.issueTracker, "assignToHuman").mockImplementation(() => {
      h.pipelineState.finishPhaseTransition("PROJ-1", "coding", () => undefined);
      h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "blocked");
      return Promise.resolve();
    });
    expect(await retryPhaseTransition(h, "PROJ-1")).toBe("cancelled");
    expect(h.pipelineState.getPendingTransition("PROJ-1")?.phaseApplied).toBe(0);
  });

  it("does not clear a replacement handoff while explicit resume is assigning", async () => {
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "code-review");
    const assign = vi.spyOn(h.issueTracker, "assignToAi").mockRejectedValue(new Error("denied"));
    await retryPhaseTransition(h, "PROJ-1");
    const previousId = h.pipelineState.getPendingTransition("PROJ-1")?.id;
    assign.mockImplementation(() => {
      h.pipelineState.finishPhaseTransition("PROJ-1", "coding", () => undefined);
      h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "code-review");
      const replacement = h.pipelineState.getPendingTransition("PROJ-1");
      if (replacement !== null) {
        h.pipelineState.confirmPhaseTransition(replacement, true);
      }
      return Promise.resolve();
    });
    const task = await resumePipeline(h, "PROJ-1");
    expect(h.pipelineState.getPendingTransition("PROJ-1")?.id).not.toBe(previousId);
    expect(h.pipelineState.isPhaseExhausted("PROJ-1", "code-review")).toBe(true);
    expect(h.queue.listByStatus("ready")).toHaveLength(1);
    expect(
      h.pipelineState.claimPhaseTask("PROJ-1", () => h.queue.markWorking(task.id), false),
    ).toBe(false);
  });

  it("reports cancellation if the human moves while an assignment notice is posting", async () => {
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "blocked");
    h.issueTracker.assignToHumanFailures.add("PROJ-1");
    vi.spyOn(h.issueTracker, "addComment").mockImplementation(() => {
      h.issueTracker.phases.set("PROJ-1", "coding");
      h.pipelineState.finishPhaseTransition("PROJ-1", "coding", () => undefined);
      return Promise.resolve();
    });
    expect(await retryPhaseTransition(h, "PROJ-1")).toBe("cancelled");
    expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
  });

  it("does not replay a pending handoff after the pipeline completes", async () => {
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "blocked");
    h.pipelineState.markDone("PROJ-1");
    await retryPhaseTransition(h, "PROJ-1");
    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("done");
    expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
    expect(h.issueTracker.calls).toEqual([]);
  });

  it("allows a new handoff after explicit re-entry from a completed cycle", async () => {
    h.pipelineState.markDone("PROJ-1");
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "code-review");
    await retryPhaseTransition(h, "PROJ-1");
    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("code-review");
    expect(h.queue.hasOpenTask("PROJ-1", "code-review")).toBe(true);
  });

  it("does not commit a stale handoff if completion happens during the tracker write", async () => {
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "blocked");
    vi.spyOn(h.issueTracker, "setPhase").mockImplementation(() => {
      h.pipelineState.markDone("PROJ-1");
      return Promise.resolve();
    });
    await retryPhaseTransition(h, "PROJ-1");
    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("done");
    expect(h.queue.listByStatus("ready")).toHaveLength(0);
  });
});
