import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../../core/database.js";
import { SqliteTaskQueue } from "../../core/queue.js";
import { OrchestratorStateStore } from "../../core/pipeline-state.js";
import { DualWriteAuditLogger } from "../../core/audit.js";
import { DashboardServer } from "../server.js";

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
      { host: "127.0.0.1", port, enableDashboardUi: true },
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
      { host: "127.0.0.1", port, enableDashboardUi: false },
    );
    await server.start();
    const root = await fetchText("/");
    expect(root.status).toBe(404);
    const health = await fetchJson("/health");
    expect(health.status).toBe(200);
  });
});
