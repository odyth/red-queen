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
import { RuntimeState } from "../runtime-state.js";
import type { PhaseDefinition } from "../types.js";
import { MockIssueTracker, MockSourceControl } from "./fixtures/mock-adapters.js";
import { makeTestConfig } from "./fixtures/test-config.js";

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
});
