import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routeAiAssignment } from "../assignment-router.js";
import { DualWriteAuditLogger } from "../audit.js";
import { buildPhaseGraph } from "../config.js";
import { SCHEMA_SQL } from "../database.js";
import { DEFAULT_PHASES } from "../defaults.js";
import { PipelineStateStore } from "../pipeline-state.js";
import { SqliteTaskQueue } from "../queue.js";
import { RuntimeState } from "../runtime-state.js";
import { MockIssueTracker } from "./fixtures/mock-adapters.js";
import { makeTestConfig } from "./fixtures/test-config.js";

let db: BetterSqlite3.Database;
let queue: SqliteTaskQueue;
let pipelineState: PipelineStateStore;
let audit: DualWriteAuditLogger;
let runtime: RuntimeState;
let issueTracker: MockIssueTracker;
let tempDir: string;

describe("routeAiAssignment", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-assignment-router-"));
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    queue = new SqliteTaskQueue(db);
    pipelineState = new PipelineStateStore(db);
    audit = new DualWriteAuditLogger(db, join(tempDir, "audit.log"));
    runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    issueTracker = new MockIssueTracker();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function route(issueId: string, delegator: string | null = null) {
    if (issueTracker.assignments.has(issueId) === false) {
      issueTracker.assignments.set(issueId, "ai");
    }
    return routeAiAssignment(
      { issueTracker, queue, runtime, pipelineState, audit },
      {
        issueId,
        component: "assignment-router-test",
        description: "Assigned to AI",
        delegator,
      },
    );
  }

  it("enqueues new-ticket for an unphased assignment with no local record", async () => {
    const result = await route("PROJ-NEW");

    expect(result).toEqual({
      outcome: "enqueued",
      reason: "enqueued",
      phase: null,
      taskType: "new-ticket",
    });
    expect(queue.hasOpenTask("PROJ-NEW", "new-ticket")).toBe(true);
    expect(queue.listByStatus("ready")[0]?.metadata.requiresAiAssignment).toBe(true);
  });

  it("deduplicates an assignment whose target task is already open", async () => {
    queue.enqueue({ type: "new-ticket", issueId: "PROJ-DUP" });

    const result = await route("PROJ-DUP");

    expect(result).toMatchObject({
      outcome: "skipped",
      reason: "already-queued",
      taskType: "new-ticket",
    });
    expect(queue.listByStatus("ready")).toHaveLength(1);
  });

  it("routes the live automated phase and preserves delegator data", async () => {
    pipelineState.create("PROJ-LIVE", "spec-writing");
    issueTracker.phases.set("PROJ-LIVE", "coding");

    const result = await route("PROJ-LIVE", "delegator-1");

    expect(result).toEqual({
      outcome: "enqueued",
      reason: "enqueued",
      phase: "coding",
      taskType: "coding",
    });
    const task = queue
      .listByStatus("ready")
      .find((candidate) => candidate.issueId === "PROJ-LIVE" && candidate.type === "coding");
    expect(task?.metadata.delegator).toBe("delegator-1");
    expect(pipelineState.get("PROJ-LIVE")?.delegatorAccountId).toBe("delegator-1");
  });

  it("rechecks local state after the live phase lookup", async () => {
    let resolveState:
      | ((state: { phase: string | null; assignedToAi: boolean }) => void)
      | undefined;
    issueTracker.getAiAssignmentState = () =>
      new Promise((resolve) => {
        resolveState = resolve;
      });

    const pendingRoute = route("PROJ-STATE-RACE", "delegator-race");
    pipelineState.create("PROJ-STATE-RACE", "coding");
    expect(resolveState).toBeDefined();
    resolveState?.({ phase: null, assignedToAi: true });

    const result = await pendingRoute;

    expect(result).toMatchObject({
      outcome: "skipped",
      reason: "unphased-existing-state",
    });
    expect(queue.listByStatus("ready")).toHaveLength(0);
    expect(pipelineState.get("PROJ-STATE-RACE")?.delegatorAccountId).toBe("delegator-race");
  });

  it("does not enqueue work while the live phase is a human gate", async () => {
    pipelineState.create("PROJ-GATE", "coding");
    issueTracker.phases.set("PROJ-GATE", "spec-review");

    const result = await route("PROJ-GATE");

    expect(result).toMatchObject({
      outcome: "skipped",
      reason: "human-gate",
      phase: "spec-review",
      taskType: null,
    });
    expect(queue.listByStatus("ready")).toHaveLength(0);
  });

  it("defers without enqueueing when live assignment state cannot be read", async () => {
    pipelineState.create("PROJ-FAIL", "coding", "delegator-old");
    issueTracker.getPhaseThrowsFor.add("PROJ-FAIL");

    const result = await route("PROJ-FAIL", "delegator-new");

    expect(result).toEqual({
      outcome: "deferred",
      reason: "assignment-state-read-failed",
      phase: null,
      taskType: null,
    });
    expect(queue.listByStatus("ready")).toHaveLength(0);
    expect(
      audit
        .query({ issueId: "PROJ-FAIL" })
        .some((entry) => entry.message.includes("assignment state read failed")),
    ).toBe(true);
    expect(pipelineState.get("PROJ-FAIL")?.delegatorAccountId).toBe("delegator-new");
  });

  it("does not enqueue when the AI assignment was revoked before routing", async () => {
    pipelineState.create("PROJ-REVOKED", "coding", "delegator-old");
    issueTracker.assignments.set("PROJ-REVOKED", "human");

    const result = await route("PROJ-REVOKED", "delegator-new");

    expect(result).toEqual({
      outcome: "skipped",
      reason: "assignment-revoked",
      phase: null,
      taskType: null,
    });
    expect(queue.listByStatus("ready")).toHaveLength(0);
    expect(pipelineState.get("PROJ-REVOKED")?.delegatorAccountId).toBe("delegator-new");
  });

  it("does not restart an unphased assignment with existing local state", async () => {
    pipelineState.create("PROJ-EXISTING", "coding");

    const result = await route("PROJ-EXISTING");

    expect(result).toMatchObject({
      outcome: "skipped",
      reason: "unphased-existing-state",
      phase: null,
      taskType: null,
    });
    expect(queue.listByStatus("ready")).toHaveLength(0);
  });

  it("re-kicks a failed entry-phase task even when local state matches", async () => {
    pipelineState.create("PROJ-RETRY", "spec-writing");
    issueTracker.phases.set("PROJ-RETRY", "spec-writing");
    const failedTask = queue.enqueue({ type: "spec-writing", issueId: "PROJ-RETRY" });
    queue.markWorking(failedTask.id);
    queue.markFailed(failedTask.id, "worker failed");

    const result = await route("PROJ-RETRY");

    expect(result).toEqual({
      outcome: "enqueued",
      reason: "enqueued",
      phase: "spec-writing",
      taskType: "spec-writing",
    });
    expect(queue.listByStatus("ready")).toHaveLength(1);
    expect(queue.getTask(failedTask.id)?.status).toBe("failed");
  });
});
