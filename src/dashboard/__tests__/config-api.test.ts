import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { makeTestConfig } from "../../core/__tests__/fixtures/test-config.js";
import { DashboardServer } from "../server.js";

let db: BetterSqlite3.Database;
let tempDir: string;
let server: DashboardServer;
let port: number;
let configPath: string;
let runtime: RuntimeState;
let reloadCalls: RedQueenConfig[];

const VALID_YAML = `
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
`;

const VALID_YAML_WITH_PLACEHOLDER = `
issueTracker:
  type: jira
  config:
    baseUrl: https://example.atlassian.net
    email: me@example.com
    apiToken: \${JIRA_TOKEN}
    cloudId: abc
    projectKey: RQ
    customFields:
      phase: phase
      spec: spec
    phaseMapping:
      spec-writing:
        optionId: "1"
      spec-review:
        optionId: "2"
      coding:
        optionId: "3"
      code-review:
        optionId: "4"
      testing:
        optionId: "5"
      human-review:
        optionId: "6"
      spec-feedback:
        optionId: "7"
      code-feedback:
        optionId: "8"
      blocked:
        optionId: "9"
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
`;

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

function setEnv(key: string, value: string): void {
  vi.stubEnv(key, value);
}

describe("Dashboard config API", () => {
  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-config-api-"));
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    const queue = new SqliteTaskQueue(db);
    const orchestratorState = new OrchestratorStateStore(db);
    const audit = new DualWriteAuditLogger(db, join(tempDir, "audit.log"));
    configPath = join(tempDir, "redqueen.yaml");
    writeFileSync(configPath, VALID_YAML, "utf8");

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
            return { applied: ["audit.retentionDays"], restartRequired: [] };
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
    vi.unstubAllEnvs();
  });

  it("GET /api/config returns raw YAML and envRefs", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/config`);
    const body = (await res.json()) as { yaml: string; envRefs: { name: string; set: boolean }[] };
    expect(res.status).toBe(200);
    expect(body.yaml).toContain("issueTracker");
    expect(Array.isArray(body.envRefs)).toBe(true);
  });

  it("GET /api/config returns envRefs with set flag reflecting process.env", async () => {
    writeFileSync(configPath, VALID_YAML_WITH_PLACEHOLDER, "utf8");
    setEnv("JIRA_TOKEN", "abcdefghijk");
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/config`);
    const body = (await res.json()) as { envRefs: { name: string; set: boolean }[] };
    const jiraRef = body.envRefs.find((r) => r.name === "JIRA_TOKEN");
    expect(jiraRef).toBeDefined();
    expect(jiraRef?.set).toBe(true);
  });

  it("POST /api/config/validate returns ok:true on valid YAML", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/config/validate`, {
      method: "POST",
      body: VALID_YAML,
    });
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("POST /api/config/validate returns ok:false on invalid YAML", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/config/validate`, {
      method: "POST",
      body: "::: not yaml :::",
    });
    const body = (await res.json()) as { ok: boolean; errors: string[] };
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("PUT /api/config with ${JIRA_TOKEN} placeholder is accepted and calls reload", async () => {
    setEnv("JIRA_TOKEN", "abcdefghijk");
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/config`, {
      method: "PUT",
      body: VALID_YAML_WITH_PLACEHOLDER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied: string[] };
    expect(body.ok).toBe(true);
    expect(reloadCalls.length).toBe(1);
    // file persisted
    expect(readFileSync(configPath, "utf8")).toBe(VALID_YAML_WITH_PLACEHOLDER);
  });

  it("PUT /api/config rejects YAML containing a literal resolved secret value", async () => {
    setEnv("JIRA_TOKEN", "abcdefghijk");
    const leaked = VALID_YAML_WITH_PLACEHOLDER.replace("${JIRA_TOKEN}", "abcdefghijk");
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/config`, {
      method: "PUT",
      body: leaked,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: string[] };
    expect(body.errors[0]).toBe(
      "literal value of ${JIRA_TOKEN} detected; use ${JIRA_TOKEN} instead",
    );
    // file must not have been written
    expect(readFileSync(configPath, "utf8")).toBe(VALID_YAML);
    expect(reloadCalls.length).toBe(0);
  });

  it("PUT /api/config does not false-positive on short env values", async () => {
    // Short value — below the 8-char threshold — must not be treated as a secret.
    setEnv("JIRA_TOKEN", "abc");
    // Submitted YAML contains the literal "abc" via buildCommand.
    const withShort = VALID_YAML_WITH_PLACEHOLDER.replace(
      "buildCommand: npm run build",
      "buildCommand: abc",
    );
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/config`, {
      method: "PUT",
      body: withShort,
    });
    expect(res.status).toBe(200);
  });

  it("PUT /api/config rejects invalid YAML and does not write file", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/config`, {
      method: "PUT",
      body: "::: not yaml :::",
    });
    expect(res.status).toBe(400);
    expect(readFileSync(configPath, "utf8")).toBe(VALID_YAML);
    expect(reloadCalls.length).toBe(0);
  });
});
