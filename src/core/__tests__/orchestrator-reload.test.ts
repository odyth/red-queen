import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DualWriteAuditLogger } from "../audit.js";
import { buildPhaseGraph } from "../config.js";
import type { RedQueenConfig } from "../config.js";
import { SCHEMA_SQL } from "../database.js";
import { DEFAULT_PHASES } from "../defaults.js";
import { RedQueen } from "../orchestrator.js";
import { OrchestratorStateStore, PipelineStateStore } from "../pipeline-state.js";
import { SqliteTaskQueue } from "../queue.js";
import { reconcile } from "../reconciler.js";
import { RuntimeState } from "../runtime-state.js";
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

let db: BetterSqlite3.Database;
let tempDir: string;

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

function buildOrchestrator(runtime: RuntimeState, skillsDir: string): RedQueen {
  const queue = new SqliteTaskQueue(db);
  const pipelineState = new PipelineStateStore(db);
  const orchestratorState = new OrchestratorStateStore(db);
  const audit = new DualWriteAuditLogger(db, join(tempDir, "audit.log"));
  return new RedQueen({
    runtime,
    queue,
    pipelineState,
    orchestratorState,
    audit,
    issueTracker: new MockIssueTracker(),
    sourceControl: new MockSourceControl(),
    builtInSkillsDir: skillsDir,
    installSignalHandlers: false,
    workerRunner: () =>
      Promise.resolve({ success: true, exitCode: 0, elapsed: 0, summary: "", error: null }),
  });
}

describe("Orchestrator.reload", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-reload-"));
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    mkdirSync(join(tempDir, "skills"), { recursive: true });
    mkdirSync(join(tempDir, "skills", "coder"), { recursive: true });
    writeFileSync(join(tempDir, "skills", "coder", "SKILL.md"), "# coder\n");
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("mutates phaseGraph in place; observers sharing runtime see the new graph", () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const orchestrator = buildOrchestrator(runtime, join(tempDir, "skills"));

    expect(runtime.phaseGraph.getPhaseNames()).toContain("coding");

    const newConfig: RedQueenConfig = { ...runtime.config, phases: SINGLE_PHASE };
    const result = orchestrator.reload(newConfig);

    // Graph swap visible through the same runtime reference observers already hold.
    expect(runtime.phaseGraph.getPhaseNames()).toEqual(["solo-phase"]);
    expect(runtime.config).toBe(newConfig);
    expect(result.applied).toContain("phases");
  });

  it("splits applied vs restartRequired based on what changed", () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const orchestrator = buildOrchestrator(runtime, join(tempDir, "skills"));

    const newConfig: RedQueenConfig = {
      ...runtime.config,
      audit: { ...runtime.config.audit, retentionDays: runtime.config.audit.retentionDays + 1 },
      skills: { ...runtime.config.skills, directory: "/tmp/new-skills" },
      issueTracker: { type: "mock", config: { different: "value" } },
      dashboard: { ...runtime.config.dashboard, port: runtime.config.dashboard.port + 1 },
    };
    const result = orchestrator.reload(newConfig);

    expect(result.applied).toContain("audit.retentionDays");
    expect(result.applied).toContain("skills.directory");
    expect(result.restartRequired).toContain("issueTracker");
    expect(result.restartRequired).toContain("dashboard.listener");
  });

  it("does not report unchanged sections", () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const orchestrator = buildOrchestrator(runtime, join(tempDir, "skills"));

    const result = orchestrator.reload(runtime.config);
    expect(result.applied).toEqual([]);
    expect(result.restartRequired).toEqual([]);
  });

  it("leaves runtime untouched when new config has an invalid phase graph", () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const orchestrator = buildOrchestrator(runtime, join(tempDir, "skills"));
    const originalGraph = runtime.phaseGraph;
    const originalConfig = runtime.config;

    const badPhases: PhaseDefinition[] = [
      {
        name: "spec-writing",
        label: "Spec",
        type: "automated",
        skill: "prompt-writer",
        next: "does-not-exist",
        assignTo: "ai",
      },
    ];
    const badConfig: RedQueenConfig = { ...runtime.config, phases: badPhases };

    expect(() => orchestrator.reload(badConfig)).toThrow();
    expect(runtime.phaseGraph).toBe(originalGraph);
    expect(runtime.config).toBe(originalConfig);
  });

  // End-to-end: prove reload() is observed by reconciler and webhook, not
  // just by a direct runtime.phaseGraph reference check. Covers the gap
  // between "field mutation works" and "subsystems built before reload()
  // still see the new graph when they run."
  it("reload() is observed by a reconciler and webhook sharing the same runtime", async () => {
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const orchestrator = buildOrchestrator(runtime, join(tempDir, "skills"));

    // Subsystems are constructed BEFORE reload(). They each hold a reference
    // to `runtime` — the shared-ref design means they pick up the swap.
    const queue = new SqliteTaskQueue(db);
    const pipelineState = new PipelineStateStore(db);
    const orchestratorState = new OrchestratorStateStore(db);
    const audit = new DualWriteAuditLogger(db, join(tempDir, "audit.log"));
    const issueTracker = new MockIssueTracker();
    const sourceControl = new MockSourceControl();

    const port = await getFreePort();
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
      // Sanity: before reload, "coding" is a valid phase and routes from a webhook.
      issueTracker.parseResult = {
        source: "webhook",
        type: "phase-change",
        issueId: "PROJ-1",
        timestamp: new Date().toISOString(),
        payload: { phase: "coding" },
      };
      pipelineState.create("PROJ-1", "coding");
      await fetch(`http://127.0.0.1:${String(port)}/webhook/issue-tracker`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(queue.hasOpenTask("PROJ-1", "coding")).toBe(true);

      // Swap via reload() — the public entry point, not a direct field write.
      const newConfig: RedQueenConfig = { ...runtime.config, phases: SINGLE_PHASE };
      const result = orchestrator.reload(newConfig);
      expect(result.applied).toContain("phases");

      // Reconciler built with a captured `runtime` reference now sees only
      // the new phase — "coding" is no longer queried because it's no longer
      // in the automated phases list.
      issueTracker.calls.length = 0;
      issueTracker.listByPhaseResults.clear();
      issueTracker.listByPhaseResults.set("solo-phase", [makeIssue("PROJ-2", "solo-phase")]);
      const reconcileResult = await reconcile({
        issueTracker,
        queue,
        runtime,
        pipelineState,
        audit,
      });
      expect(reconcileResult.issuesFound).toBe(1);
      expect(issueTracker.calls.some((c) => c.includes(":coding"))).toBe(false);
      expect(issueTracker.calls.some((c) => c.includes(":solo-phase"))).toBe(true);

      // Webhook observes the new graph too — "coding" is now unknown.
      issueTracker.parseResult = {
        source: "webhook",
        type: "phase-change",
        issueId: "PROJ-3",
        timestamp: new Date().toISOString(),
        payload: { phase: "coding" },
      };
      await fetch(`http://127.0.0.1:${String(port)}/webhook/issue-tracker`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(queue.hasOpenTask("PROJ-3", "coding")).toBe(false);
    } finally {
      await dashboard.stop();
    }
  });
});
