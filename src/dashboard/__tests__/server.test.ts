import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { request as httpRequestRaw } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../../core/database.js";
import { SqliteTaskQueue } from "../../core/queue.js";
import { OrchestratorStateStore } from "../../core/pipeline-state.js";
import { DualWriteAuditLogger } from "../../core/audit.js";
import { buildPhaseGraph } from "../../core/config.js";
import { DEFAULT_PHASES } from "../../core/defaults.js";
import { RuntimeState } from "../../core/runtime-state.js";
import { makeTestConfig } from "../../core/__tests__/fixtures/test-config.js";
import { DashboardServer } from "../server.js";
import type { DashboardEditorDeps } from "../server.js";

let db: BetterSqlite3.Database;
let tempDir: string;
let server: DashboardServer;
let port: number;

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

async function fetchJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`);
  const body = (await res.json()) as unknown;
  return { status: res.status, body };
}

async function fetchText(path: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`);
  const text = await res.text();
  return { status: res.status, text };
}

// fetch/undici forbids overriding the Host header, so spoofed-host tests must
// use the node:http client directly.
function httpRequest(
  method: string,
  path: string,
  hostHeader: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequestRaw(
      { host: "127.0.0.1", port, path, method, headers: { host: hostHeader } },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          resolvePromise({ status: res.statusCode ?? 0, body: data });
        });
      },
    );
    req.on("error", rejectPromise);
    req.end();
  });
}

function httpGet(path: string, hostHeader: string): Promise<{ status: number; body: string }> {
  return httpRequest("GET", path, hostHeader);
}

// Minimal editor deps so control-plane routes register. The handlers only need
// to run without throwing 404 — a valid config file backs configPath.
function makeEditorDeps(): DashboardEditorDeps {
  const configPath = join(tempDir, "redqueen.yaml");
  writeFileSync(configPath, "issueTracker:\n  type: mock\n  config: {}\n", "utf8");
  mkdirSync(join(tempDir, ".redqueen", "skills"), { recursive: true });
  const runtime = new RuntimeState(
    buildPhaseGraph(DEFAULT_PHASES),
    makeTestConfig({ phases: DEFAULT_PHASES }),
  );
  return {
    runtime,
    configPath,
    projectRoot: tempDir,
    builtInSkillsDir: join(tempDir, "bundled-skills"),
    reload: () => ({ applied: [], restartRequired: [] }),
  };
}

describe("DashboardServer", () => {
  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-dash-"));
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    const queue = new SqliteTaskQueue(db);
    const orchestratorState = new OrchestratorStateStore(db);
    const audit = new DualWriteAuditLogger(db, join(tempDir, "audit.log"));
    port = await getFreePort();
    server = new DashboardServer(
      { queue, orchestratorState, audit },
      {
        host: "127.0.0.1",
        port,
        enableDashboardUi: true,
        allowNonLoopback: false,
        allowedHosts: [],
      },
    );
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("serves dashboard HTML", async () => {
    const { status, text } = await fetchText("/");
    expect(status).toBe(200);
    expect(text).toContain("Red Queen");
  });

  it("returns health JSON", async () => {
    const { status, body } = await fetchJson("/health");
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok" });
  });

  it("returns status, queue, logs JSON", async () => {
    const status = await fetchJson("/api/status");
    expect(status.status).toBe(200);
    const qBody = await fetchJson("/api/queue");
    expect(qBody.status).toBe(200);
    expect(Array.isArray(qBody.body)).toBe(true);
    const logs = await fetchJson("/api/logs");
    expect(logs.status).toBe(200);
    expect(Array.isArray(logs.body)).toBe(true);
  });

  it("returns 404 for unknown route", async () => {
    const { status } = await fetchText("/not-a-real-route");
    expect(status).toBe(404);
  });

  it("custom routes take precedence", async () => {
    server.registerRoute("GET", "/custom", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ custom: true }));
    });
    const { body } = await fetchJson("/custom");
    expect(body).toEqual({ custom: true });
  });

  it("SSE endpoint writes events", async () => {
    const controller = new AbortController();
    const eventsPromise = fetch(`http://127.0.0.1:${String(port)}/api/events`, {
      signal: controller.signal,
    });
    const res = await eventsPromise;
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // Give server a moment to register the client
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
    server.emit({ type: "orchestrator:status", data: { status: "idle" } });
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) {
      return;
    }
    let accumulated = "";
    const readOne = async (): Promise<string> => {
      const { value } = await reader.read();
      if (value === undefined) {
        return "";
      }
      return new TextDecoder().decode(value);
    };
    // Read a few chunks until we see our event
    for (let i = 0; i < 5; i++) {
      accumulated += await readOne();
      if (accumulated.includes("orchestrator:status")) {
        break;
      }
    }
    controller.abort();
    expect(accumulated).toContain("orchestrator:status");
  });

  it("hides dashboard UI when disabled but still serves health", async () => {
    await server.stop();
    port = await getFreePort();
    const queue = new SqliteTaskQueue(db);
    const orchestratorState = new OrchestratorStateStore(db);
    const audit = new DualWriteAuditLogger(db, join(tempDir, "audit2.log"));
    server = new DashboardServer(
      { queue, orchestratorState, audit },
      {
        host: "127.0.0.1",
        port,
        enableDashboardUi: false,
        allowNonLoopback: false,
        allowedHosts: [],
      },
    );
    await server.start();
    const root = await fetchText("/");
    expect(root.status).toBe(404);
    const health = await fetchJson("/health");
    expect(health.status).toBe(200);
  });

  it("rejects a foreign Host header (DNS rebinding blocked)", async () => {
    const { status } = await httpGet("/health", "evil.com");
    expect(status).toBe(403);
  });

  it("allows loopback Host headers", async () => {
    const byIp = await httpGet("/health", `127.0.0.1:${String(port)}`);
    expect(byIp.status).toBe(200);
    const byName = await httpGet("/health", `localhost:${String(port)}`);
    expect(byName.status).toBe(200);
  });

  it("honors configured allowedHosts", async () => {
    await server.stop();
    port = await getFreePort();
    const queue = new SqliteTaskQueue(db);
    const orchestratorState = new OrchestratorStateStore(db);
    const audit = new DualWriteAuditLogger(db, join(tempDir, "audit-allow.log"));
    server = new DashboardServer(
      { queue, orchestratorState, audit },
      {
        host: "127.0.0.1",
        port,
        enableDashboardUi: true,
        allowNonLoopback: false,
        allowedHosts: ["dash.internal"],
      },
    );
    await server.start();
    const allowed = await httpGet("/health", "dash.internal");
    expect(allowed.status).toBe(200);
    const denied = await httpGet("/health", "other.internal");
    expect(denied.status).toBe(403);
  });

  it("exempts custom (webhook) routes from the host allowlist", async () => {
    server.registerRoute("POST", "/webhook/test", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const { status, body } = await httpRequest("POST", "/webhook/test", "evil.com");
    expect(status).toBe(200);
    expect(body).toContain("ok");
  });

  it("does not serve the control plane on a non-loopback bind by default", async () => {
    await server.stop();
    port = await getFreePort();
    const queue = new SqliteTaskQueue(db);
    const orchestratorState = new OrchestratorStateStore(db);
    const audit = new DualWriteAuditLogger(db, join(tempDir, "audit-closed.log"));
    server = new DashboardServer(
      { queue, orchestratorState, audit, editor: makeEditorDeps() },
      { host: "0.0.0.0", port, enableDashboardUi: true, allowNonLoopback: false, allowedHosts: [] },
    );
    await server.start();
    const config = await httpGet("/api/config", `127.0.0.1:${String(port)}`);
    expect(config.status).toBe(404);
    const skill = await httpRequest("PUT", "/api/skills/foo", `127.0.0.1:${String(port)}`);
    expect(skill.status).toBe(404);
    const health = await httpGet("/health", `127.0.0.1:${String(port)}`);
    expect(health.status).toBe(200);
  });

  it("serves the control plane on a non-loopback bind when opted in", async () => {
    await server.stop();
    port = await getFreePort();
    const queue = new SqliteTaskQueue(db);
    const orchestratorState = new OrchestratorStateStore(db);
    const audit = new DualWriteAuditLogger(db, join(tempDir, "audit-open.log"));
    server = new DashboardServer(
      { queue, orchestratorState, audit, editor: makeEditorDeps() },
      { host: "0.0.0.0", port, enableDashboardUi: true, allowNonLoopback: true, allowedHosts: [] },
    );
    await server.start();
    const config = await httpGet("/api/config", `127.0.0.1:${String(port)}`);
    expect(config.status).not.toBe(404);
  });
});
