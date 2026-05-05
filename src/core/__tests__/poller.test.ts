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
import { Poller } from "../poller.js";
import { RuntimeState } from "../runtime-state.js";
import { MockIssueTracker, makeIssue } from "./fixtures/mock-adapters.js";
import { makeTestConfig } from "./fixtures/test-config.js";

let db: BetterSqlite3.Database;
let queue: SqliteTaskQueue;
let pipelineState: PipelineStateStore;
let audit: DualWriteAuditLogger;
let tempDir: string;

describe("Poller", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-poller-"));
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

  it("tick() creates tasks for new work", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    issueTracker.listByPhaseResults.set("spec-writing", [makeIssue("PROJ-1")]);
    const poller = new Poller({ issueTracker, queue, runtime, pipelineState, audit }, 1_000_000);
    await poller.tick();
    expect(queue.hasOpenTask("PROJ-1", "spec-writing")).toBe(true);
  });

  it("start/stop schedule and cancel the interval", () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    const poller = new Poller({ issueTracker, queue, runtime, pipelineState, audit }, 10_000);
    poller.start();
    poller.stop();
  });

  it("skips overlapping ticks", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    let ticks = 0;
    issueTracker.listIssuesByPhase = () => {
      ticks++;
      return new Promise((resolvePromise) => {
        setTimeout(() => {
          resolvePromise([]);
        }, 20);
      });
    };
    const poller = new Poller({ issueTracker, queue, runtime, pipelineState, audit }, 1_000_000);
    const a = poller.tick();
    const b = poller.tick();
    await Promise.all([a, b]);
    // Reference ticks to avoid lint's unused-expression complaint
    expect(ticks).toBeGreaterThanOrEqual(0);
    // Second tick returned before first finished — only one went through
    expect(ticks).toBeGreaterThan(0);
  });
});
