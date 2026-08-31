import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY, routeAiAssignment } from "../assignment-router.js";
import { DualWriteAuditLogger } from "../audit.js";
import { buildPhaseGraph } from "../config.js";
import { RedQueenDatabase } from "../database.js";
import { DEFAULT_PHASES } from "../defaults.js";
import { RedQueen } from "../orchestrator.js";
import { PhaseUsageStore } from "../phase-usage.js";
import { OrchestratorStateStore, PipelineStateStore } from "../pipeline-state.js";
import { SqliteTaskQueue } from "../queue.js";
import { reconcile } from "../reconciler.js";
import { RuntimeState } from "../runtime-state.js";
import type { Task } from "../types.js";
import { MockIssueTracker, MockSourceControl, makeIssue } from "./fixtures/mock-adapters.js";
import { makeTestConfig } from "./fixtures/test-config.js";

interface AssignmentGuardHarness {
  database: RedQueenDatabase;
  queue: SqliteTaskQueue;
  pipelineState: PipelineStateStore;
  audit: DualWriteAuditLogger;
  issueTracker: MockIssueTracker;
  runtime: RuntimeState;
  orchestrator: RedQueen;
  orchestratorState: OrchestratorStateStore;
  tempDir: string;
}

interface ProcessTaskAccess {
  processTask(task: Task): Promise<void>;
}

let harness: AssignmentGuardHarness;

describe("assignment-guarded orchestration", () => {
  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), "rq-assignment-guard-"));
    const database = new RedQueenDatabase(join(tempDir, "redqueen.db"));
    const queue = new SqliteTaskQueue(database.db);
    const pipelineState = new PipelineStateStore(database.db);
    const audit = new DualWriteAuditLogger(database.db, join(tempDir, "audit.log"));
    const issueTracker = new MockIssueTracker();
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const orchestratorState = new OrchestratorStateStore(database.db);
    const orchestrator = new RedQueen({
      runtime,
      queue,
      pipelineState,
      phaseUsage: new PhaseUsageStore(database.db),
      orchestratorState,
      audit,
      issueTracker,
      sourceControl: new MockSourceControl(),
      workerRunner: () => Promise.reject(new Error("guarded task must not dispatch a worker")),
      installSignalHandlers: false,
    });

    harness = {
      database,
      queue,
      pipelineState,
      audit,
      issueTracker,
      runtime,
      orchestrator,
      orchestratorState,
      tempDir,
    };
  });

  afterEach(() => {
    harness.database.close();
    rmSync(harness.tempDir, { recursive: true, force: true });
  });

  it("keeps a revoked phased claim open so same-phase reconciliation cannot replace it", async () => {
    const issueId = "PROJ-REVOKED";
    harness.pipelineState.create(issueId, "coding");
    harness.issueTracker.phases.set(issueId, "coding");
    harness.issueTracker.assignments.set(issueId, "human");
    harness.issueTracker.listByPhaseResults.set("coding", [makeIssue(issueId, "coding")]);
    const task = harness.queue.enqueue({
      type: "coding",
      issueId,
      metadata: { [ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY]: true },
    });

    await processTask(harness.orchestrator, task);

    expect(harness.queue.getTask(task.id)?.status).toBe("deferred");
    expect(harness.queue.getTask(task.id)?.blockedOn).toEqual(["<ai-assignment-required>"]);

    const result = await reconcile(harness);

    expect(result.tasksCreated).toBe(0);
    expect(harness.queue.getTask(task.id)?.status).toBe("ready");
    expect(harness.queue.getTask(task.id)?.metadata.requiresAiAssignment).toBe(true);
    expect(harness.queue.hasOpenTask(issueId, "coding")).toBe(true);
    expect(
      harness.queue.listByStatus("ready").filter((candidate) => candidate.issueId === issueId),
    ).toHaveLength(1);
  });

  it("retries the same task after an ownership read error and preserves its live-phase guard", async () => {
    const issueId = "PROJ-RETRY";
    let assignmentReads = 0;
    harness.issueTracker.getAiAssignmentState = () => {
      assignmentReads++;
      if (assignmentReads === 1) {
        return Promise.reject(new Error("temporary 503"));
      }
      return Promise.resolve({ assignedToAi: true, phase: "spec-writing", closed: false });
    };
    const task = harness.queue.enqueue({
      type: "new-ticket",
      issueId,
      metadata: { [ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY]: true },
    });

    await processTask(harness.orchestrator, task);

    expect(harness.queue.getTask(task.id)?.status).toBe("deferred");
    expect(harness.queue.getTask(task.id)?.blockedOn).toEqual(["<assignment-check-error>"]);
    expect(harness.queue.listByStatus("failed")).toHaveLength(0);

    harness.issueTracker.listByPhaseResults.set("spec-writing", [
      makeIssue(issueId, "spec-writing"),
    ]);
    const reconciliation = await reconcile(harness);
    expect(reconciliation.tasksCreated).toBe(0);
    expect(harness.queue.getTask(task.id)?.status).toBe("ready");

    const retry = harness.queue.dequeue();
    expect(retry?.id).toBe(task.id);
    if (retry === null) {
      throw new Error("deferred assignment claim was not released");
    }

    await processTask(harness.orchestrator, retry);

    expect(assignmentReads).toBe(2);
    expect(harness.queue.getTask(task.id)?.status).toBe("complete");
    expect(harness.queue.getTask(task.id)?.retryCount).toBe(0);
    const livePhaseTask = harness.queue
      .listByStatus("ready")
      .find((candidate) => candidate.issueId === issueId && candidate.type === "spec-writing");
    expect(livePhaseTask?.metadata.requiresAiAssignment).toBe(true);
  });

  it("does not reset a newer live phase when a stale guarded phase task retries", async () => {
    const issueId = "PROJ-STALE-RETRY";
    let assignmentReads = 0;
    harness.pipelineState.create(issueId, "coding");
    harness.issueTracker.phases.set(issueId, "coding");
    harness.issueTracker.getAiAssignmentState = () => {
      assignmentReads++;
      if (assignmentReads === 1) {
        return Promise.reject(new Error("temporary timeout"));
      }
      return Promise.resolve({ assignedToAi: true, phase: "code-review", closed: false });
    };
    const task = harness.queue.enqueue({
      type: "coding",
      issueId,
      metadata: { [ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY]: true },
    });

    await processTask(harness.orchestrator, task);
    expect(harness.queue.getTask(task.id)?.status).toBe("deferred");

    harness.issueTracker.phases.set(issueId, "code-review");
    harness.queue.releaseDeferred();
    const retry = harness.queue.dequeue();
    if (retry === null) {
      throw new Error("deferred assignment claim was not released");
    }
    await processTask(harness.orchestrator, retry);

    expect(harness.queue.getTask(task.id)?.status).toBe("complete");
    expect(harness.queue.getTask(task.id)?.result).toContain("Stale");
    expect(harness.issueTracker.phases.get(issueId)).toBe("code-review");
    expect(harness.issueTracker.calls).not.toContain(`setPhase:${issueId}:coding`);
  });

  it("wakes a deferred ownership hold when a positive assignment event is routed", async () => {
    const issueId = "PROJ-REASSIGNED";
    harness.pipelineState.create(issueId, "coding");
    harness.issueTracker.phases.set(issueId, "coding");
    harness.issueTracker.assignments.set(issueId, "ai");
    const task = harness.queue.enqueue({
      type: "coding",
      issueId,
      metadata: { [ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY]: true },
    });
    harness.queue.markDeferred(task.id, ["<ai-assignment-required>"]);

    const result = await routeAiAssignment(harness, {
      issueId,
      component: "test",
      description: "Reassigned to AI",
    });

    expect(result.reason).toBe("matching-local-state");
    expect(harness.queue.getTask(task.id)?.status).toBe("ready");
  });

  it("retires a guarded task when the tracker issue is closed, even with the claim revoked", async () => {
    const issueId = "PROJ-CLOSED";
    harness.pipelineState.create(issueId, "coding");
    harness.issueTracker.phases.set(issueId, "coding");
    harness.issueTracker.assignments.set(issueId, "human");
    harness.issueTracker.closedIssues.add(issueId);
    const task = harness.queue.enqueue({
      type: "coding",
      issueId,
      metadata: { [ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY]: true },
    });

    await processTask(harness.orchestrator, task);

    expect(harness.queue.getTask(task.id)?.status).toBe("complete");
    expect(harness.queue.getTask(task.id)?.result).toContain("closed");
  });

  it("fails a guarded task instead of deferring when the tracker lacks assignment support", async () => {
    const issueId = "PROJ-NO-SUPPORT";
    Object.assign(harness.issueTracker, { getAiAssignmentState: undefined });
    const task = harness.queue.enqueue({
      type: "coding",
      issueId,
      metadata: { [ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY]: true },
    });

    await processTask(harness.orchestrator, task);

    expect(harness.queue.getTask(task.id)?.status).toBe("failed");
    expect(harness.queue.getTask(task.id)?.result).toContain("support");
  });

  it("counts an assignment-check outage once, not once per deferred retry", async () => {
    const issueId = "PROJ-OUTAGE";
    harness.issueTracker.getPhaseThrowsFor.add(issueId);
    const task = harness.queue.enqueue({
      type: "coding",
      issueId,
      metadata: { [ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY]: true },
    });

    await processTask(harness.orchestrator, task);
    expect(harness.queue.getTask(task.id)?.status).toBe("deferred");
    expect(harness.orchestratorState.get().errorCount).toBe(1);

    harness.queue.releaseDeferred();
    const retry = harness.queue.dequeue();
    if (retry === null) {
      throw new Error("deferred assignment claim was not released");
    }
    await processTask(harness.orchestrator, retry);

    expect(harness.queue.getTask(task.id)?.status).toBe("deferred");
    expect(harness.orchestratorState.get().errorCount).toBe(1);
  });

  it("posts a one-time routing comment when new-ticket dead-ends on a mid-pipeline phase", async () => {
    const issueId = "PROJ-DEAD-END";
    harness.issueTracker.assignments.set(issueId, "ai");
    harness.issueTracker.phases.set(issueId, "coding");
    const task = harness.queue.enqueue({
      type: "new-ticket",
      issueId,
      metadata: { [ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY]: true },
    });

    await processTask(harness.orchestrator, task);

    expect(harness.queue.getTask(task.id)?.status).toBe("complete");
    expect(harness.queue.hasOpenTask(issueId, "coding")).toBe(false);
    const comments = harness.issueTracker.commentsById.get(issueId) ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("entry phase");
  });

  it("does not post a routing comment when new-ticket skips a human-gate phase", async () => {
    const issueId = "PROJ-GATED-SKIP";
    harness.issueTracker.assignments.set(issueId, "ai");
    harness.issueTracker.phases.set(issueId, "spec-review");
    const task = harness.queue.enqueue({
      type: "new-ticket",
      issueId,
      metadata: { [ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY]: true },
    });

    await processTask(harness.orchestrator, task);

    expect(harness.queue.getTask(task.id)?.status).toBe("complete");
    expect(harness.issueTracker.commentsById.get(issueId) ?? []).toHaveLength(0);
  });

  it("continues to create unguarded tasks for ordinary phase reconciliation", async () => {
    const issueId = "PROJ-PHASE-ONLY";
    harness.issueTracker.listByPhaseResults.set("spec-writing", [
      makeIssue(issueId, "spec-writing"),
    ]);

    const result = await reconcile(harness);

    expect(result.tasksCreated).toBe(1);
    const task = harness.queue
      .listByStatus("ready")
      .find((candidate) => candidate.issueId === issueId);
    expect(task?.type).toBe("spec-writing");
    expect(task?.metadata.requiresAiAssignment).toBeUndefined();
  });
});

async function processTask(orchestrator: RedQueen, task: Task): Promise<void> {
  await (orchestrator as unknown as ProcessTaskAccess).processTask(task);
}
