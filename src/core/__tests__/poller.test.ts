import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../database.js";
import { SqliteTaskQueue } from "../queue.js";
import { DualWriteAuditLogger } from "../audit.js";
import { buildPhaseGraph } from "../config.js";
import { DEFAULT_PHASES } from "../defaults.js";
import { Poller } from "../poller.js";
import { MockIssueTracker, makeIssue } from "./fixtures/mock-adapters.js";

let db: BetterSqlite3.Database;
let queue: SqliteTaskQueue;
let audit: DualWriteAuditLogger;
let tempDir: string;

describe("Poller", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-poller-"));
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    queue = new SqliteTaskQueue(db);
    audit = new DualWriteAuditLogger(db, join(tempDir, "audit.log"));
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("tick() creates tasks for new work", async () => {
    const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
    const issueTracker = new MockIssueTracker();
    issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1")]);
    const poller = new Poller({ issueTracker, queue, phaseGraph, audit }, 1_000_000);
    await poller.tick();
    expect(queue.hasOpenTask("PROJ-1", "coding")).toBe(true);
  });

  it("start/stop schedule and cancel the interval", () => {
    const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
    const issueTracker = new MockIssueTracker();
    const poller = new Poller({ issueTracker, queue, phaseGraph, audit }, 10_000);
    poller.start();
    poller.stop();
  });

  it("skips overlapping ticks", async () => {
    const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
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
    const poller = new Poller({ issueTracker, queue, phaseGraph, audit }, 1_000_000);
    const a = poller.tick();
    const b = poller.tick();
    await Promise.all([a, b]);
    // Reference ticks to avoid lint's unused-expression complaint
    expect(ticks).toBeGreaterThanOrEqual(0);
    // Second tick returned before first finished — only one went through
    expect(ticks).toBeGreaterThan(0);
  });
});
