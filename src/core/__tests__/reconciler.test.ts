import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../database.js";
import { SqliteTaskQueue } from "../queue.js";
import { PipelineStateStore } from "../pipeline-state.js";
import { DualWriteAuditLogger } from "../audit.js";
import { buildPhaseGraph } from "../config.js";
import { DEFAULT_PHASES } from "../defaults.js";
import { reconcile } from "../reconciler.js";
import { RuntimeState } from "../runtime-state.js";
import { MockIssueTracker, makeIssue } from "./fixtures/mock-adapters.js";
import { makeTestConfig } from "./fixtures/test-config.js";

let db: BetterSqlite3.Database;
let queue: SqliteTaskQueue;
let pipelineState: PipelineStateStore;
let audit: DualWriteAuditLogger;
let tempDir: string;

describe("reconcile", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-reconcile-"));
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    queue = new SqliteTaskQueue(db);
    pipelineState = new PipelineStateStore(db);
    audit = new DualWriteAuditLogger(db, join(tempDir, "audit.log"));
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates tasks for untracked issues in automated phases when local state exists", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);
    pipelineState.create("PROJ-1", "coding");

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.issuesFound).toBe(1);
    expect(result.tasksCreated).toBe(1);
    expect(queue.hasOpenTask("PROJ-1", "coding")).toBe(true);
  });

  it("skips issues that already have open tasks", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    queue.enqueue({ type: "coding", issueId: "PROJ-1" });
    issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.tasksCreated).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("recovers an unphased issue assigned to AI as a new ticket", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.assignedToAiResults = [makeIssue("PROJ-ASSIGNED")];

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.issuesFound).toBe(1);
    expect(result.tasksCreated).toBe(1);
    expect(queue.hasOpenTask("PROJ-ASSIGNED", "new-ticket")).toBe(true);
  });

  it("does not duplicate an open new-ticket on later sweeps", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.assignedToAiResults = [makeIssue("PROJ-ASSIGNED")];

    const first = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });
    const second = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(first.tasksCreated).toBe(1);
    expect(second.tasksCreated).toBe(0);
    expect(second.skipped).toBe(1);
    expect(queue.listByStatus("ready")).toHaveLength(1);
  });

  it("does not restart an unphased assignment with existing pipeline state", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.assignedToAiResults = [makeIssue("PROJ-EXISTING")];
    pipelineState.create("PROJ-EXISTING", "coding");

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.tasksCreated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(queue.hasOpenTask("PROJ-EXISTING", "new-ticket")).toBe(false);
  });

  it("leaves phase-tagged assignments to the existing phase sweep", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    const issue = makeIssue("PROJ-PHASED", "coding");
    issueTracker.assignedToAiResults = [issue];
    issueTracker.listByPhaseResults.set("coding", [issue]);
    pipelineState.create(issue.id, "coding");

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.issuesFound).toBe(1);
    expect(result.tasksCreated).toBe(1);
    expect(queue.hasOpenTask(issue.id, "coding")).toBe(true);
    expect(queue.hasOpenTask(issue.id, "new-ticket")).toBe(false);
  });

  it("skips human-gated recovery candidates without a live assignment read", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.assignedToAiResults = [makeIssue("PROJ-GATED", "spec-review")];

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.issuesFound).toBe(1);
    expect(result.tasksCreated).toBe(0);
    expect(issueTracker.calls).not.toContain("getAiAssignmentState:PROJ-GATED");
    expect(queue.listByStatus("ready")).toHaveLength(0);
  });

  it("lets the phase sweep win over a stale unphased assignment snapshot", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.assignedToAiResults = [makeIssue("PROJ-RACE")];
    issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-RACE", "coding")]);
    pipelineState.create("PROJ-RACE", "coding");

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.issuesFound).toBe(1);
    expect(result.tasksCreated).toBe(1);
    expect(queue.hasOpenTask("PROJ-RACE", "coding")).toBe(true);
    expect(queue.hasOpenTask("PROJ-RACE", "new-ticket")).toBe(false);
  });

  it("routes an assigned issue from its live phase instead of a stale search snapshot", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.assignedToAiResults = [makeIssue("PROJ-LIVE")];
    issueTracker.phases.set("PROJ-LIVE", "coding");
    pipelineState.create("PROJ-LIVE", "spec-writing");

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.issuesFound).toBe(1);
    expect(result.tasksCreated).toBe(1);
    expect(issueTracker.calls).toContain("getAiAssignmentState:PROJ-LIVE");
    expect(queue.hasOpenTask("PROJ-LIVE", "coding")).toBe(true);
    expect(queue.hasOpenTask("PROJ-LIVE", "new-ticket")).toBe(false);
  });

  it("continues assignment recovery when one candidate's live state read fails", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.assignedToAiResults = [makeIssue("PROJ-BROKEN"), makeIssue("PROJ-HEALTHY")];
    issueTracker.getPhaseThrowsFor.add("PROJ-BROKEN");

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.issuesFound).toBe(2);
    expect(result.tasksCreated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(queue.hasOpenTask("PROJ-BROKEN", "new-ticket")).toBe(false);
    expect(queue.hasOpenTask("PROJ-HEALTHY", "new-ticket")).toBe(true);
  });

  it("does not recover a stale snapshot after the AI assignment was revoked", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.assignedToAiResults = [makeIssue("PROJ-REVOKED")];
    issueTracker.assignments.set("PROJ-REVOKED", "human");

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.tasksCreated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(queue.hasOpenTask("PROJ-REVOKED", "new-ticket")).toBe(false);
  });

  it("bounds live assignment reads while preserving discovery order", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    const issueIds = Array.from({ length: 12 }, (_, index) => `PROJ-${String(index + 1)}`);
    issueTracker.assignedToAiResults = issueIds.map((issueId) => makeIssue(issueId));
    let activeReads = 0;
    let maxActiveReads = 0;
    issueTracker.getAiAssignmentState = async () => {
      activeReads++;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeReads--;
      return { phase: null, assignedToAi: true };
    };

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.tasksCreated).toBe(issueIds.length);
    expect(maxActiveReads).toBeGreaterThan(1);
    expect(maxActiveReads).toBeLessThanOrEqual(8);
    expect(queue.listByStatus("ready").map((task) => task.issueId)).toEqual(issueIds);
  });

  it("continues the phase sweep when assignment discovery fails", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.listIssuesAssignedToAi = () => Promise.reject(new Error("assignment API down"));
    issueTracker.listByPhaseResults.set("spec-writing", [
      makeIssue("PROJ-PHASE-FALLBACK", "spec-writing"),
    ]);

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.tasksCreated).toBe(1);
    expect(queue.hasOpenTask("PROJ-PHASE-FALLBACK", "spec-writing")).toBe(true);
    expect(
      audit
        .query({ component: "reconciler" })
        .some((entry) => entry.message.includes("Failed to list issues assigned to AI")),
    ).toBe(true);
  });

  it("does not recreate the phase that was active when a processed PR merged", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);
    pipelineState.create("PROJ-1", "coding");
    pipelineState.markDone("PROJ-1");

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.tasksCreated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(queue.hasOpenTask("PROJ-1", "coding")).toBe(false);
  });

  it("allows a completed issue to re-enter through a different automated phase", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.listByPhaseResults.set("code-review", [makeIssue("PROJ-1", "code-review")]);
    pipelineState.create("PROJ-1", "coding");
    pipelineState.markDone("PROJ-1");

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.tasksCreated).toBe(1);
    expect(queue.hasOpenTask("PROJ-1", "code-review")).toBe(true);
  });

  it("does not query human-gate phases", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.listByPhaseResults.set("spec-review", [makeIssue("PROJ-9")]);

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.issuesFound).toBe(0);
    expect(issueTracker.calls.some((c) => c.includes("spec-review"))).toBe(false);
  });

  it("continues when listIssuesByPhase throws", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    // Throw on coding
    issueTracker.listIssuesByPhase = (phase: string) => {
      if (phase === "coding") {
        return Promise.reject(new Error("API down"));
      }
      return Promise.resolve([]);
    };

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });
    expect(result.issuesFound).toBe(0);
  });

  it("dedups same issue appearing in multiple phases", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    const issue = makeIssue("PROJ-1");
    issueTracker.listByPhaseResults.set("coding", [issue]);
    issueTracker.listByPhaseResults.set("code-review", [issue]);
    pipelineState.create("PROJ-1", "coding");

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });
    expect(result.issuesFound).toBe(1);
    expect(result.tasksCreated).toBe(1);
  });

  it("skips non-entry phase issue when no local pipeline state exists", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-2", "coding")]);

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.issuesFound).toBe(1);
    expect(result.tasksCreated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(queue.hasOpenTask("PROJ-2", "coding")).toBe(false);
  });

  it("enqueues entry-phase issue even without a local pipeline record", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.listByPhaseResults.set("spec-writing", [makeIssue("PROJ-3", "spec-writing")]);

    const result = await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(result.issuesFound).toBe(1);
    expect(result.tasksCreated).toBe(1);
    expect(queue.hasOpenTask("PROJ-3", "spec-writing")).toBe(true);
  });

  it("releases deferred tasks on every sweep", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    const task = queue.enqueue({ type: "coding", issueId: "PROJ-9" });
    queue.markDeferred(task.id, ["PROJ-8"]);

    await reconcile({ issueTracker, queue, runtime, pipelineState, audit });

    expect(queue.getTask(task.id)?.status).toBe("ready");
  });
});
