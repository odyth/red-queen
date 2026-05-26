import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DualWriteAuditLogger } from "../../core/audit.js";
import { buildPhaseGraph } from "../../core/config.js";
import type { RedQueenConfig } from "../../core/config.js";
import { SCHEMA_SQL } from "../../core/database.js";
import { DEFAULT_PHASES } from "../../core/defaults.js";
import { OrchestratorStateStore } from "../../core/pipeline-state.js";
import { SqliteTaskQueue } from "../../core/queue.js";
import { RuntimeState } from "../../core/runtime-state.js";
import type { PhaseDefinition } from "../../core/types.js";
import { makeTestConfig } from "../../core/__tests__/fixtures/test-config.js";
import { DashboardServer } from "../server.js";

let db: BetterSqlite3.Database;
let tempDir: string;
let server: DashboardServer;
let port: number;
let queue: SqliteTaskQueue;
let runtime: RuntimeState;
let configPath: string;
let reloadCalls: RedQueenConfig[];

const BASE_YAML_WITH_COMMENT = `# Preserved header comment.
issueTracker:
  type: mock
  config: {}
sourceControl:
  type: mock
  config: {}
project:
  buildCommand: npm run build
  testCommand: npm test
pipeline:
  pollInterval: 30
dashboard:
  port: 4400
audit:
  logFile: audit.log
  retentionDays: 30
phases:
  - name: spec-writing
    label: Spec Writing
    type: automated
    skill: prompt-writer
    next: done
    assignTo: ai
# Trailing comment that must also survive.
`;

const NEW_PHASES: PhaseDefinition[] = [
  {
    name: "spec-writing",
    label: "Spec Writing v2",
    type: "automated",
    skill: "prompt-writer",
    next: "done",
    assignTo: "ai",
  },
];

async function getFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolvePort) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr !== null ? addr.port : 0;
      s.close(() => {
        resolvePort(p);
      });
    });
  });
}

describe("Dashboard workflow API", () => {
  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-workflow-api-"));
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    queue = new SqliteTaskQueue(db);
    const orchestratorState = new OrchestratorStateStore(db);
    const audit = new DualWriteAuditLogger(db, join(tempDir, "audit.log"));

    configPath = join(tempDir, "redqueen.yaml");
    writeFileSync(configPath, BASE_YAML_WITH_COMMENT, "utf8");
    mkdirSync(join(tempDir, ".redqueen", "skills"), { recursive: true });

    runtime = new RuntimeState(
      buildPhaseGraph(DEFAULT_PHASES),
      makeTestConfig({ phases: DEFAULT_PHASES }),
    );
    reloadCalls = [];
    port = await getFreePort();
    server = new DashboardServer(
      {
        queue,
        orchestratorState,
        audit,
        editor: {
          runtime,
          configPath,
          projectRoot: tempDir,
          builtInSkillsDir: join(tempDir, "bundled-skills"),
          reload: (cfg) => {
            reloadCalls.push(cfg);
            return { applied: ["phases"], restartRequired: [] };
          },
        },
      },
      { host: "127.0.0.1", port, enableDashboardUi: true },
    );
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("PUT /api/workflow with one ready task returns 409 with readyCount: 1", async () => {
    queue.enqueue({ type: "coding", issueId: "PROJ-1" });
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/workflow`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phases: NEW_PHASES }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      readyCount: number;
      workingCount: number;
      message: string;
    };
    expect(body.readyCount).toBe(1);
    expect(body.workingCount).toBe(0);
    expect(body.message).toContain("open tasks");
    expect(reloadCalls.length).toBe(0);
  });

  it("PUT /api/workflow with one working task returns 409 with workingCount: 1", async () => {
    const task = queue.enqueue({ type: "coding", issueId: "PROJ-1" });
    queue.markWorking(task.id);
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/workflow`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phases: NEW_PHASES }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { readyCount: number; workingCount: number };
    expect(body.workingCount).toBe(1);
    expect(body.readyCount).toBe(0);
  });

  it("PUT /api/workflow with empty queue succeeds, rewrites YAML, preserves comments", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/workflow`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phases: NEW_PHASES }),
    });
    expect(res.status).toBe(200);
    const onDisk = readFileSync(configPath, "utf8");
    expect(onDisk).toContain("# Preserved header comment.");
    expect(onDisk).toContain("# Trailing comment that must also survive.");
    expect(onDisk).toContain("Spec Writing v2");
    expect(reloadCalls.length).toBe(1);
  });

  it("POST /api/workflow/validate returns ok:false on unknown phase reference", async () => {
    const bad: PhaseDefinition[] = [
      {
        name: "spec-writing",
        label: "Spec",
        type: "automated",
        skill: "prompt-writer",
        next: "nonexistent",
        assignTo: "ai",
      },
    ];
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/workflow/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phases: bad }),
    });
    const body = (await res.json()) as { ok: boolean; errors: string[] };
    expect(body.ok).toBe(false);
    expect(body.errors.join(" ")).toContain("nonexistent");
  });

  it("GET /api/workflow returns phases, entryPhases, humanGates", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/workflow`);
    const body = (await res.json()) as {
      phases: PhaseDefinition[];
      entryPhases: string[];
      humanGates: string[];
    };
    expect(body.phases.length).toBe(DEFAULT_PHASES.length);
    expect(body.entryPhases).toContain("spec-writing");
    expect(body.humanGates).toContain("spec-review");
  });
});
