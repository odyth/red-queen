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
import { MockIssueTracker, makeIssue } from "./fixtures/mock-adapters.js";

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
    const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
    const issueTracker = new MockIssueTracker();
    issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);
    pipelineState.create("PROJ-1", "coding");

    const result = await reconcile({ issueTracker, queue, phaseGraph, pipelineState, audit });

    expect(result.issuesFound).toBe(1);
    expect(result.tasksCreated).toBe(1);
    expect(queue.hasOpenTask("PROJ-1", "coding")).toBe(true);
  });

  it("skips issues that already have open tasks", async () => {
    const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
    const issueTracker = new MockIssueTracker();
    queue.enqueue({ type: "coding", issueId: "PROJ-1" });
    issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);

    const result = await reconcile({ issueTracker, queue, phaseGraph, pipelineState, audit });

    expect(result.tasksCreated).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("does not query human-gate phases", async () => {
    const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
    const issueTracker = new MockIssueTracker();
    issueTracker.listByPhaseResults.set("spec-review", [makeIssue("PROJ-9")]);

    const result = await reconcile({ issueTracker, queue, phaseGraph, pipelineState, audit });

    expect(result.issuesFound).toBe(0);
    expect(issueTracker.calls.some((c) => c.includes("spec-review"))).toBe(false);
  });

  it("continues when listIssuesByPhase throws", async () => {
    const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
    const issueTracker = new MockIssueTracker();
    // Throw on coding
    issueTracker.listIssuesByPhase = (phase: string) => {
      if (phase === "coding") {
        return Promise.reject(new Error("API down"));
      }
      return Promise.resolve([]);
    };

    const result = await reconcile({ issueTracker, queue, phaseGraph, pipelineState, audit });
    expect(result.issuesFound).toBe(0);
  });

  it("dedups same issue appearing in multiple phases", async () => {
    const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
    const issueTracker = new MockIssueTracker();
    const issue = makeIssue("PROJ-1");
    issueTracker.listByPhaseResults.set("coding", [issue]);
    issueTracker.listByPhaseResults.set("code-review", [issue]);
    pipelineState.create("PROJ-1", "coding");

    const result = await reconcile({ issueTracker, queue, phaseGraph, pipelineState, audit });
    expect(result.issuesFound).toBe(1);
    expect(result.tasksCreated).toBe(1);
  });

  it("skips non-entry phase issue when no local pipeline state exists", async () => {
    const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
    const issueTracker = new MockIssueTracker();
    issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-2", "coding")]);

    const result = await reconcile({ issueTracker, queue, phaseGraph, pipelineState, audit });

    expect(result.issuesFound).toBe(1);
    expect(result.tasksCreated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(queue.hasOpenTask("PROJ-2", "coding")).toBe(false);
  });

  it("enqueues entry-phase issue even without a local pipeline record", async () => {
    const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
    const issueTracker = new MockIssueTracker();
    issueTracker.listByPhaseResults.set("spec-writing", [makeIssue("PROJ-3", "spec-writing")]);

    const result = await reconcile({ issueTracker, queue, phaseGraph, pipelineState, audit });

    expect(result.issuesFound).toBe(1);
    expect(result.tasksCreated).toBe(1);
    expect(queue.hasOpenTask("PROJ-3", "spec-writing")).toBe(true);
  });
});
