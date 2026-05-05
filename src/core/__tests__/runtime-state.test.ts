import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../database.js";
import { SqliteTaskQueue } from "../queue.js";
import { PipelineStateStore, OrchestratorStateStore } from "../pipeline-state.js";
import { DualWriteAuditLogger } from "../audit.js";
import { buildPhaseGraph } from "../config.js";
import { DEFAULT_PHASES } from "../defaults.js";
import { reconcile } from "../reconciler.js";
import { RuntimeState } from "../runtime-state.js";
import { PhaseGraph } from "../types.js";
import type { PhaseDefinition } from "../types.js";
import { DashboardServer } from "../../dashboard/server.js";
import { WebhookServer } from "../../webhook/server.js";
import { MockIssueTracker, MockSourceControl, makeIssue } from "./fixtures/mock-adapters.js";
import { makeTestConfig } from "./fixtures/test-config.js";

async function getFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolvePromise) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr !== null ? addr.port : 0;
      s.close(() => {
        resolvePromise(p);
      });
    });
  });
}

const SINGLE_PHASE: PhaseDefinition[] = [
  {
    name: "solo-phase",
    label: "Solo",
    type: "automated",
    skill: "coder",
    next: "done",
    assignTo: "ai",
  },
];

describe("RuntimeState", () => {
  let db: BetterSqlite3.Database;
  let tempDir: string;
  let queue: SqliteTaskQueue;
  let pipelineState: PipelineStateStore;
  let audit: DualWriteAuditLogger;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-runtime-state-"));
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

  it("exposes mutable phaseGraph and config fields", () => {
    const graphA = buildPhaseGraph(DEFAULT_PHASES);
    const runtime = new RuntimeState(graphA, makeTestConfig());
    expect(runtime.phaseGraph).toBe(graphA);

    const graphB = new PhaseGraph(SINGLE_PHASE);
    runtime.phaseGraph = graphB;
    expect(runtime.phaseGraph).toBe(graphB);
  });

  it("mutation to runtime.phaseGraph is visible to reconciler and webhook server sharing the same reference", async () => {
    // Shared runtime starts on the default phase graph.
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const issueTracker = new MockIssueTracker();
    const sourceControl = new MockSourceControl();

    // Fixture 1 — reconciler. Seed an issue on a phase that only exists in the default graph.
    issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);
    pipelineState.create("PROJ-1", "coding");

    const resultBefore = await reconcile({
      issueTracker,
      queue,
      runtime,
      pipelineState,
      audit,
    });
    expect(resultBefore.issuesFound).toBe(1);
    expect(resultBefore.tasksCreated).toBe(1);

    // Fixture 2 — webhook server on the same runtime.
    const port = await getFreePort();
    const orchestratorState = new OrchestratorStateStore(db);
    const dashboard = new DashboardServer(
      { queue, orchestratorState, audit },
      { host: "127.0.0.1", port, enableDashboardUi: true },
    );
    await dashboard.start();
    const webhook = new WebhookServer({
      issueTracker,
      sourceControl,
      queue,
      pipelineState,
      runtime,
      audit,
    });
    webhook.register(dashboard);

    try {
      // Before mutation — a phase-change to "coding" routes because "coding" exists in the
      // default graph and it's not a human gate.
      issueTracker.parseResult = {
        source: "webhook",
        type: "phase-change",
        issueId: "PROJ-2",
        timestamp: new Date().toISOString(),
        payload: { phase: "coding" },
      };
      pipelineState.create("PROJ-2", "coding");
      await fetch(`http://127.0.0.1:${String(port)}/webhook/issue-tracker`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(queue.hasOpenTask("PROJ-2", "coding")).toBe(true);

      // Hot-swap the phase graph to a minimal graph that has only "solo-phase".
      runtime.phaseGraph = new PhaseGraph(SINGLE_PHASE);

      // Reconciler observes the new graph — "coding" no longer exists, so listIssuesByPhase("coding")
      // is never called. Only "solo-phase" is queried.
      issueTracker.calls.length = 0;
      issueTracker.listByPhaseResults.clear();
      issueTracker.listByPhaseResults.set("solo-phase", [makeIssue("PROJ-3", "solo-phase")]);
      const resultAfter = await reconcile({
        issueTracker,
        queue,
        runtime,
        pipelineState,
        audit,
      });
      expect(resultAfter.issuesFound).toBe(1);
      expect(issueTracker.calls.some((c) => c.includes(":coding"))).toBe(false);
      expect(issueTracker.calls.some((c) => c.includes(":solo-phase"))).toBe(true);

      // Webhook observes the new graph too. A phase-change to "coding" now references an unknown
      // phase so no task is created.
      issueTracker.parseResult = {
        source: "webhook",
        type: "phase-change",
        issueId: "PROJ-4",
        timestamp: new Date().toISOString(),
        payload: { phase: "coding" },
      };
      await fetch(`http://127.0.0.1:${String(port)}/webhook/issue-tracker`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(queue.hasOpenTask("PROJ-4", "coding")).toBe(false);

      // But the new phase routes correctly.
      issueTracker.parseResult = {
        source: "webhook",
        type: "phase-change",
        issueId: "PROJ-5",
        timestamp: new Date().toISOString(),
        payload: { phase: "solo-phase" },
      };
      pipelineState.create("PROJ-5", "solo-phase");
      await fetch(`http://127.0.0.1:${String(port)}/webhook/issue-tracker`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(queue.hasOpenTask("PROJ-5", "solo-phase")).toBe(true);
    } finally {
      await dashboard.stop();
    }
  });
});
