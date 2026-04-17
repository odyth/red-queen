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
