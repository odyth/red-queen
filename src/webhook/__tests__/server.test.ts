import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../../core/database.js";
import { SqliteTaskQueue } from "../../core/queue.js";
import { PipelineStateStore, OrchestratorStateStore } from "../../core/pipeline-state.js";
import { DualWriteAuditLogger } from "../../core/audit.js";
import { buildPhaseGraph } from "../../core/config.js";
import { DEFAULT_PHASES } from "../../core/defaults.js";
import { DashboardServer } from "../../dashboard/server.js";
import { WebhookServer } from "../server.js";
import {
  MockIssueTracker,
  MockSourceControl,
} from "../../core/__tests__/fixtures/mock-adapters.js";
import type { PipelineEvent } from "../../core/types.js";

let db: BetterSqlite3.Database;
let tempDir: string;
let queue: SqliteTaskQueue;
let pipelineState: PipelineStateStore;
let audit: DualWriteAuditLogger;
let dashboard: DashboardServer;
let port: number;
let issueTracker: MockIssueTracker;
let sourceControl: MockSourceControl;

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

async function postWebhook(path: string, body: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("WebhookServer", () => {
  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-webhook-"));
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    queue = new SqliteTaskQueue(db);
    pipelineState = new PipelineStateStore(db);
    const orchestratorState = new OrchestratorStateStore(db);
    audit = new DualWriteAuditLogger(db, join(tempDir, "audit.log"));
    issueTracker = new MockIssueTracker();
    sourceControl = new MockSourceControl();
    port = await getFreePort();
    dashboard = new DashboardServer(
      { queue, orchestratorState, audit },
      { host: "127.0.0.1", port, enableDashboardUi: true },
    );
    await dashboard.start();
    const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
    const webhook = new WebhookServer({
      issueTracker,
      sourceControl,
      queue,
      pipelineState,
      phaseGraph,
      audit,
    });
    webhook.register(dashboard);
  });

  afterEach(async () => {
    await dashboard.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects invalid signature with 401", async () => {
    issueTracker.validateResult = false;
    const res = await postWebhook("/webhook/issue-tracker", "{}");
    expect(res.status).toBe(401);
  });

  it("accepts valid signature and enqueues phase-change task", async () => {
    issueTracker.validateResult = true;
    const event: PipelineEvent = {
      source: "webhook",
      type: "phase-change",
      issueId: "PROJ-1",
      timestamp: new Date().toISOString(),
      payload: { phase: "coding" },
    };
    issueTracker.parseResult = event;
    const res = await postWebhook("/webhook/issue-tracker", "{}");
    expect(res.status).toBe(200);
    // Small wait for async dispatch
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.hasOpenTask("PROJ-1", "coding")).toBe(true);
  });

  it("skips phase-change to human gate", async () => {
    issueTracker.parseResult = {
      source: "webhook",
      type: "phase-change",
      issueId: "PROJ-1",
      timestamp: new Date().toISOString(),
      payload: { phase: "spec-review" },
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.hasOpenTask("PROJ-1", "spec-review")).toBe(false);
  });

  it("creates code-feedback task when PR exists", async () => {
    pipelineState.create("PROJ-1", "code-review");
    pipelineState.updatePrNumber("PROJ-1", 42);
    sourceControl.parseResult = {
      source: "webhook",
      type: "pr-feedback",
      issueId: "PROJ-1",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/source-control", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.hasOpenTask("PROJ-1", "code-feedback")).toBe(true);
  });

  it("creates spec-feedback task when no PR", async () => {
    pipelineState.create("PROJ-1", "spec-review");
    sourceControl.parseResult = {
      source: "webhook",
      type: "pr-feedback",
      issueId: "PROJ-1",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/source-control", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.hasOpenTask("PROJ-1", "spec-feedback")).toBe(true);
  });

  it("creates new-ticket task on assignment-change without phase", async () => {
    issueTracker.parseResult = {
      source: "webhook",
      type: "assignment-change",
      issueId: "PROJ-1",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.hasOpenTask("PROJ-1", "new-ticket")).toBe(true);
  });

  it("dedups duplicate events", async () => {
    const event: PipelineEvent = {
      source: "webhook",
      type: "phase-change",
      issueId: "PROJ-1",
      timestamp: new Date().toISOString(),
      payload: { phase: "coding" },
    };
    issueTracker.parseResult = event;
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.listByStatus("ready")).toHaveLength(1);
  });

  it("null parseResult triggers no enqueue", async () => {
    issueTracker.parseResult = null;
    const res = await postWebhook("/webhook/issue-tracker", "{}");
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.listByStatus("ready")).toHaveLength(0);
  });

  it("marks pipeline done on pr-merged", async () => {
    pipelineState.create("PROJ-1", "human-review");
    sourceControl.parseResult = {
      source: "webhook",
      type: "pr-merged",
      issueId: "PROJ-1",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/source-control", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(pipelineState.get("PROJ-1")?.currentPhase).toBe("done");
  });
});

describe("WebhookServer custom paths", () => {
  let db2: BetterSqlite3.Database;
  let tempDir2: string;
  let queue2: SqliteTaskQueue;
  let pipelineState2: PipelineStateStore;
  let audit2: DualWriteAuditLogger;
  let dashboard2: DashboardServer;
  let port2: number;
  let issueTracker2: MockIssueTracker;
  let sourceControl2: MockSourceControl;

  beforeEach(async () => {
    tempDir2 = mkdtempSync(join(tmpdir(), "rq-webhook-paths-"));
    db2 = new Database(":memory:");
    db2.exec(SCHEMA_SQL);
    queue2 = new SqliteTaskQueue(db2);
    pipelineState2 = new PipelineStateStore(db2);
    const orchestratorState2 = new OrchestratorStateStore(db2);
    audit2 = new DualWriteAuditLogger(db2, join(tempDir2, "audit.log"));
    issueTracker2 = new MockIssueTracker();
    sourceControl2 = new MockSourceControl();
    port2 = await getFreePort();
    dashboard2 = new DashboardServer(
      { queue: queue2, orchestratorState: orchestratorState2, audit: audit2 },
      { host: "127.0.0.1", port: port2, enableDashboardUi: true },
    );
    await dashboard2.start();
    const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
    const webhook = new WebhookServer({
      issueTracker: issueTracker2,
      sourceControl: sourceControl2,
      queue: queue2,
      pipelineState: pipelineState2,
      phaseGraph,
      audit: audit2,
    });
    webhook.register(dashboard2, {
      issueTracker: "/webhook/jira",
      sourceControl: "/webhook/github",
    });
  });

  afterEach(async () => {
    await dashboard2.stop();
    db2.close();
    rmSync(tempDir2, { recursive: true, force: true });
  });

  it("accepts issue-tracker events on the custom path", async () => {
    issueTracker2.parseResult = {
      source: "webhook",
      type: "phase-change",
      issueId: "PROJ-9",
      timestamp: new Date().toISOString(),
      payload: { phase: "coding" },
    };
    const res = await fetch(`http://127.0.0.1:${String(port2)}/webhook/jira`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(queue2.hasOpenTask("PROJ-9", "coding")).toBe(true);
  });

  it("accepts source-control events on the custom path", async () => {
    pipelineState2.create("PROJ-9", "code-review");
    pipelineState2.updatePrNumber("PROJ-9", 7);
    sourceControl2.parseResult = {
      source: "webhook",
      type: "pr-feedback",
      issueId: "PROJ-9",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    const res = await fetch(`http://127.0.0.1:${String(port2)}/webhook/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(queue2.hasOpenTask("PROJ-9", "code-feedback")).toBe(true);
  });

  it("404s on the default path when custom paths are registered", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port2)}/webhook/issue-tracker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});
