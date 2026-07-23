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
import { RuntimeState } from "../../core/runtime-state.js";
import { DashboardServer } from "../../dashboard/server.js";
import { WebhookServer } from "../server.js";
import {
  MockIssueTracker,
  MockSourceControl,
} from "../../core/__tests__/fixtures/mock-adapters.js";
import { makeTestConfig } from "../../core/__tests__/fixtures/test-config.js";
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
      {
        host: "127.0.0.1",
        port,
        enableDashboardUi: true,
        allowNonLoopback: false,
        allowedHosts: [],
      },
    );
    await dashboard.start();
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const webhook = new WebhookServer({
      issueTracker,
      sourceControl,
      queue,
      pipelineState,
      runtime,
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
    pipelineState.create("PROJ-1", "spec-writing");
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

  it("eagerly transitions to code-feedback and reassigns to AI when feedback lands at a human gate", async () => {
    pipelineState.create("PROJ-1", "human-review");
    pipelineState.updatePrNumber("PROJ-1", 42);
    issueTracker.phases.set("PROJ-1", "human-review");
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
    // Status + assignment flip synchronously so the human's review queue updates
    // the moment they leave feedback, instead of waiting for the orchestrator.
    const setIdx = issueTracker.calls.indexOf("setPhase:PROJ-1:code-feedback");
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(issueTracker.calls.indexOf("assignToAi:PROJ-1")).toBeGreaterThan(setIdx);
    expect(pipelineState.get("PROJ-1")?.currentPhase).toBe("code-feedback");
  });

  it("eagerly transitions to spec-feedback when feedback lands at the spec-review gate (no PR)", async () => {
    pipelineState.create("PROJ-1", "spec-review");
    issueTracker.phases.set("PROJ-1", "spec-review");
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
    expect(issueTracker.calls).toContain("setPhase:PROJ-1:spec-feedback");
    expect(issueTracker.calls).toContain("assignToAi:PROJ-1");
  });

  it("enqueues feedback without transitioning when the ticket is mid-automation (not at a human gate)", async () => {
    pipelineState.create("PROJ-1", "code-review");
    pipelineState.updatePrNumber("PROJ-1", 42);
    issueTracker.phases.set("PROJ-1", "code-review");
    sourceControl.parseResult = {
      source: "webhook",
      type: "pr-feedback",
      issueId: "PROJ-1",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/source-control", "{}");
    await new Promise((r) => setTimeout(r, 30));
    // Feedback is still captured, but the orchestrator owns the transition while
    // it's actively working the ticket — webhook leaves tracker state untouched.
    expect(queue.hasOpenTask("PROJ-1", "code-feedback")).toBe(true);
    expect(issueTracker.calls.some((c) => c.startsWith("setPhase:"))).toBe(false);
    expect(issueTracker.calls.some((c) => c.startsWith("assignToAi:"))).toBe(false);
    expect(pipelineState.get("PROJ-1")?.currentPhase).toBe("code-review");
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
    pipelineState.create("PROJ-1", "spec-writing");
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

  it("pr-merged with no pipeline record skips cleanup without throwing", async () => {
    sourceControl.parseResult = {
      source: "webhook",
      type: "pr-merged",
      issueId: "PROJ-GHOST",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    const res = await postWebhook("/webhook/source-control", "{}");
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(pipelineState.get("PROJ-GHOST")).toBeNull();
  });

  it("phase-change to non-entry phase with no local state logs skip", async () => {
    issueTracker.parseResult = {
      source: "webhook",
      type: "phase-change",
      issueId: "PROJ-5",
      timestamp: new Date().toISOString(),
      payload: { phase: "coding" },
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.hasOpenTask("PROJ-5", "coding")).toBe(false);
  });

  it("phase-change to entry phase on fresh DB enqueues", async () => {
    issueTracker.parseResult = {
      source: "webhook",
      type: "phase-change",
      issueId: "PROJ-6",
      timestamp: new Date().toISOString(),
      payload: { phase: "spec-writing" },
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.hasOpenTask("PROJ-6", "spec-writing")).toBe(true);
  });

  it("assignment-change on stale non-entry Jira phase logs skip, no enqueue", async () => {
    issueTracker.phases.set("PROJ-7", "code-review");
    issueTracker.parseResult = {
      source: "webhook",
      type: "assignment-change",
      issueId: "PROJ-7",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.hasOpenTask("PROJ-7", "new-ticket")).toBe(false);
    expect(queue.hasOpenTask("PROJ-7", "code-review")).toBe(false);
    expect(queue.listByStatus("ready")).toHaveLength(0);
  });

  it("assignment-change with null Jira phase enqueues new-ticket", async () => {
    issueTracker.parseResult = {
      source: "webhook",
      type: "assignment-change",
      issueId: "PROJ-8",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.hasOpenTask("PROJ-8", "new-ticket")).toBe(true);
  });

  it("assignment-change with entry-phase Jira phase enqueues that phase", async () => {
    issueTracker.phases.set("PROJ-10", "spec-writing");
    issueTracker.parseResult = {
      source: "webhook",
      type: "assignment-change",
      issueId: "PROJ-10",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.hasOpenTask("PROJ-10", "spec-writing")).toBe(true);
    expect(queue.hasOpenTask("PROJ-10", "new-ticket")).toBe(false);
  });

  it("assignment-change updates delegator on existing record", async () => {
    pipelineState.create("PROJ-11", "coding");
    issueTracker.parseResult = {
      source: "webhook",
      type: "assignment-change",
      issueId: "PROJ-11",
      timestamp: new Date().toISOString(),
      payload: { delegator: "justin-123" },
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(pipelineState.get("PROJ-11")?.delegatorAccountId).toBe("justin-123");
  });

  it("assignment-change on entry-phase Jira state plumbs delegator into task metadata", async () => {
    issueTracker.phases.set("PROJ-12", "spec-writing");
    issueTracker.parseResult = {
      source: "webhook",
      type: "assignment-change",
      issueId: "PROJ-12",
      timestamp: new Date().toISOString(),
      payload: { delegator: "justin-99" },
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    const ready = queue.listByStatus("ready");
    const task = ready.find((t) => t.issueId === "PROJ-12" && t.type === "spec-writing");
    expect(task?.metadata.delegator).toBe("justin-99");
  });

  it("assignment-change without pipeline row plumbs delegator into new-ticket task", async () => {
    issueTracker.parseResult = {
      source: "webhook",
      type: "assignment-change",
      issueId: "PROJ-13",
      timestamp: new Date().toISOString(),
      payload: { delegator: "justin-13" },
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    const ready = queue.listByStatus("ready");
    const task = ready.find((t) => t.issueId === "PROJ-13" && t.type === "new-ticket");
    expect(task?.metadata.delegator).toBe("justin-13");
  });

  it("assignment-change enqueues the live Jira phase when a human advanced it mid-pipeline", async () => {
    pipelineState.create("PROJ-15", "spec-writing");
    issueTracker.phases.set("PROJ-15", "coding");
    issueTracker.parseResult = {
      source: "webhook",
      type: "assignment-change",
      issueId: "PROJ-15",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.hasOpenTask("PROJ-15", "coding")).toBe(true);
  });

  it("assignment-change does not enqueue when Jira phase matches local state", async () => {
    pipelineState.create("PROJ-16", "coding");
    issueTracker.phases.set("PROJ-16", "coding");
    issueTracker.parseResult = {
      source: "webhook",
      type: "assignment-change",
      issueId: "PROJ-16",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.listByStatus("ready")).toHaveLength(0);
  });

  it("assignment-change while parked at a human gate creates no task", async () => {
    pipelineState.create("PROJ-17", "coding");
    issueTracker.phases.set("PROJ-17", "spec-review");
    issueTracker.parseResult = {
      source: "webhook",
      type: "assignment-change",
      issueId: "PROJ-17",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.listByStatus("ready")).toHaveLength(0);
  });

  it("assignment-change with no Jira phase and no local state enqueues new-ticket", async () => {
    issueTracker.parseResult = {
      source: "webhook",
      type: "assignment-change",
      issueId: "PROJ-18",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.hasOpenTask("PROJ-18", "new-ticket")).toBe(true);
  });

  it("assignment-change re-kicks an entry phase that matches local state (failed-task retry)", async () => {
    pipelineState.create("PROJ-19", "spec-writing");
    issueTracker.phases.set("PROJ-19", "spec-writing");
    issueTracker.parseResult = {
      source: "webhook",
      type: "assignment-change",
      issueId: "PROJ-19",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.hasOpenTask("PROJ-19", "spec-writing")).toBe(true);
  });

  it("assignment-change logs an audit entry when it no-ops on matching local state", async () => {
    pipelineState.create("PROJ-20", "coding");
    issueTracker.phases.set("PROJ-20", "coding");
    issueTracker.parseResult = {
      source: "webhook",
      type: "assignment-change",
      issueId: "PROJ-20",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.listByStatus("ready")).toHaveLength(0);
    const entries = audit.query({ issueId: "PROJ-20" });
    expect(entries.some((e) => e.message.includes("matches local state"))).toBe(true);
  });

  it("assignment-change defers to poller (no task) when the Jira phase read fails", async () => {
    pipelineState.create("PROJ-21", "spec-writing");
    issueTracker.getPhaseThrowsFor.add("PROJ-21");
    issueTracker.parseResult = {
      source: "webhook",
      type: "assignment-change",
      issueId: "PROJ-21",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.listByStatus("ready")).toHaveLength(0);
    const entries = audit.query({ issueId: "PROJ-21" });
    expect(entries.some((e) => e.message.includes("deferring to poller"))).toBe(true);
  });

  it("phase-change updates delegator and propagates to task metadata", async () => {
    pipelineState.create("PROJ-14", "spec-writing");
    issueTracker.parseResult = {
      source: "webhook",
      type: "phase-change",
      issueId: "PROJ-14",
      timestamp: new Date().toISOString(),
      payload: { phase: "coding", delegator: "justin-14" },
    };
    await postWebhook("/webhook/issue-tracker", "{}");
    await new Promise((r) => setTimeout(r, 30));
    expect(pipelineState.get("PROJ-14")?.delegatorAccountId).toBe("justin-14");
    const ready = queue.listByStatus("ready");
    const task = ready.find((t) => t.issueId === "PROJ-14" && t.type === "coding");
    expect(task?.metadata.delegator).toBe("justin-14");
  });
});

describe("WebhookServer pr-merged cleanup", () => {
  let db3: BetterSqlite3.Database;
  let tempDir3: string;
  let queue3: SqliteTaskQueue;
  let pipelineState3: PipelineStateStore;
  let audit3: DualWriteAuditLogger;
  let dashboard3: DashboardServer;
  let port3: number;
  let issueTracker3: MockIssueTracker;
  let sourceControl3: MockSourceControl;
  let gitCalls: { args: string[]; cwd: string }[];
  let worktreeDir: string;

  beforeEach(async () => {
    tempDir3 = mkdtempSync(join(tmpdir(), "rq-webhook-cleanup-"));
    worktreeDir = join(tempDir3, "worktree");
    // Create worktree dir so existsSync gate passes
    rmSync(worktreeDir, { recursive: true, force: true });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(worktreeDir, { recursive: true });
    db3 = new Database(":memory:");
    db3.exec(SCHEMA_SQL);
    queue3 = new SqliteTaskQueue(db3);
    pipelineState3 = new PipelineStateStore(db3);
    const orchestratorState3 = new OrchestratorStateStore(db3);
    audit3 = new DualWriteAuditLogger(db3, join(tempDir3, "audit.log"));
    issueTracker3 = new MockIssueTracker();
    sourceControl3 = new MockSourceControl();
    gitCalls = [];
    port3 = await getFreePort();
    dashboard3 = new DashboardServer(
      { queue: queue3, orchestratorState: orchestratorState3, audit: audit3 },
      {
        host: "127.0.0.1",
        port: port3,
        enableDashboardUi: true,
        allowNonLoopback: false,
        allowedHosts: [],
      },
    );
    await dashboard3.start();
    const config = makeTestConfig({
      project: {
        buildCommand: "npm run build",
        testCommand: "npm test",
        directory: tempDir3,
      },
    });
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), config);
    const webhook = new WebhookServer({
      issueTracker: issueTracker3,
      sourceControl: sourceControl3,
      queue: queue3,
      pipelineState: pipelineState3,
      runtime,
      audit: audit3,
      gitRunner: (args, cwd) => {
        gitCalls.push({ args, cwd });
        return Promise.resolve();
      },
    });
    webhook.register(dashboard3);
  });

  afterEach(async () => {
    await dashboard3.stop();
    db3.close();
    rmSync(tempDir3, { recursive: true, force: true });
  });

  it("removes worktree, deletes branch, and nulls branch info on pr-merged", async () => {
    pipelineState3.create("PROJ-200", "human-review");
    pipelineState3.updateBranchInfo("PROJ-200", {
      branchName: "feature/PROJ-200",
      prNumber: 42,
      worktreePath: worktreeDir,
    });
    sourceControl3.parseResult = {
      source: "webhook",
      type: "pr-merged",
      issueId: "PROJ-200",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await fetch(`http://127.0.0.1:${String(port3)}/webhook/source-control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(gitCalls).toEqual([
      { args: ["worktree", "remove", "--force", "--", worktreeDir], cwd: tempDir3 },
      { args: ["branch", "-D", "--", "feature/PROJ-200"], cwd: tempDir3 },
    ]);
    const record = pipelineState3.get("PROJ-200");
    expect(record?.currentPhase).toBe("done");
    expect(record?.branchName).toBeNull();
    expect(record?.prNumber).toBeNull();
    expect(record?.worktreePath).toBeNull();
  });

  it("does not invoke git when branch and worktree are null", async () => {
    pipelineState3.create("PROJ-201", "human-review");
    sourceControl3.parseResult = {
      source: "webhook",
      type: "pr-merged",
      issueId: "PROJ-201",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    await fetch(`http://127.0.0.1:${String(port3)}/webhook/source-control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(gitCalls).toHaveLength(0);
    expect(pipelineState3.get("PROJ-201")?.currentPhase).toBe("done");
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
      {
        host: "127.0.0.1",
        port: port2,
        enableDashboardUi: true,
        allowNonLoopback: false,
        allowedHosts: [],
      },
    );
    await dashboard2.start();
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
    const webhook = new WebhookServer({
      issueTracker: issueTracker2,
      sourceControl: sourceControl2,
      queue: queue2,
      pipelineState: pipelineState2,
      runtime,
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
    pipelineState2.create("PROJ-9", "spec-writing");
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

describe("WebhookServer pr-merged stack retarget + refresh", () => {
  let db4: BetterSqlite3.Database;
  let tempDir4: string;
  let queue4: SqliteTaskQueue;
  let pipelineState4: PipelineStateStore;
  let dashboard4: DashboardServer;
  let port4: number;
  let sourceControl4: MockSourceControl;
  let gitCalls4: { args: string[]; cwd: string }[];
  let failOnMerge: boolean;

  beforeEach(async () => {
    tempDir4 = mkdtempSync(join(tmpdir(), "rq-webhook-stack-"));
    db4 = new Database(":memory:");
    db4.exec(SCHEMA_SQL);
    queue4 = new SqliteTaskQueue(db4);
    pipelineState4 = new PipelineStateStore(db4);
    const orchestratorState4 = new OrchestratorStateStore(db4);
    const audit4 = new DualWriteAuditLogger(db4, join(tempDir4, "audit.log"));
    const issueTracker4 = new MockIssueTracker();
    sourceControl4 = new MockSourceControl();
    gitCalls4 = [];
    failOnMerge = false;
    port4 = await getFreePort();
    dashboard4 = new DashboardServer(
      { queue: queue4, orchestratorState: orchestratorState4, audit: audit4 },
      {
        host: "127.0.0.1",
        port: port4,
        enableDashboardUi: true,
        allowNonLoopback: false,
        allowedHosts: [],
      },
    );
    await dashboard4.start();
    const config = makeTestConfig({
      project: {
        buildCommand: "npm run build",
        testCommand: "npm test",
        directory: tempDir4,
      },
    });
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), config);
    const webhook = new WebhookServer({
      issueTracker: issueTracker4,
      sourceControl: sourceControl4,
      queue: queue4,
      pipelineState: pipelineState4,
      runtime,
      audit: audit4,
      gitRunner: (args, cwd) => {
        gitCalls4.push({ args, cwd });
        if (failOnMerge && args[0] === "merge") {
          return Promise.reject(new Error("merge conflict"));
        }
        return Promise.resolve();
      },
    });
    webhook.register(dashboard4);

    // Merged blocker PROJ-200 (feature/PROJ-200 → main).
    pipelineState4.create("PROJ-200", "human-review");
    pipelineState4.updateBranchInfo("PROJ-200", {
      branchName: "feature/PROJ-200",
      prNumber: 42,
    });
    sourceControl4.parseResult = {
      source: "webhook",
      type: "pr-merged",
      issueId: "PROJ-200",
      timestamp: new Date().toISOString(),
      payload: { branch: "feature/PROJ-200", base: "main" },
    };
  });

  afterEach(async () => {
    await dashboard4.stop();
    db4.close();
    rmSync(tempDir4, { recursive: true, force: true });
  });

  function seedDependent(issueId: string, prNumber: number, base: string, state = "open"): void {
    pipelineState4.create(issueId, "human-review");
    pipelineState4.updateBranchInfo(issueId, {
      branchName: `feature/${issueId}`,
      prNumber,
    });
    sourceControl4.prs.set(prNumber, {
      number: prNumber,
      title: issueId,
      state,
      headBranch: `feature/${issueId}`,
      baseBranch: base,
      url: `https://example.com/pr/${String(prNumber)}`,
      reviewDecision: null,
    });
  }

  async function fireMerge(): Promise<void> {
    await fetch(`http://127.0.0.1:${String(port4)}/webhook/source-control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await new Promise((r) => setTimeout(r, 50));
  }

  it("retargets the matching open PR and pushes a clean refresh", async () => {
    seedDependent("PROJ-201", 43, "feature/PROJ-200");
    seedDependent("PROJ-202", 44, "main");
    seedDependent("PROJ-203", 45, "feature/PROJ-200", "closed");

    await fireMerge();

    expect(sourceControl4.calls).toContain("updatePullRequestBase:43:main");
    expect(sourceControl4.calls).not.toContain("updatePullRequestBase:44:main");
    expect(sourceControl4.calls).not.toContain("updatePullRequestBase:45:main");
    expect(sourceControl4.prs.get(43)?.baseBranch).toBe("main");
    expect(sourceControl4.prs.get(44)?.baseBranch).toBe("main");

    const flat = gitCalls4.map((c) => c.args.join(" "));
    expect(flat).toContain(
      "fetch origin +refs/heads/main:refs/remotes/origin/main +refs/heads/feature/PROJ-201:refs/remotes/origin/feature/PROJ-201",
    );
    expect(flat.some((c) => c.startsWith("worktree add --detach"))).toBe(true);
    expect(flat).toContain("merge --no-edit origin/main");
    expect(flat).toContain("push origin HEAD:feature/PROJ-201");
    // Pre-emptive remove (self-heal for stale temp worktrees) plus the finally
    // cleanup — and the pre-emptive one lands before the add.
    expect(flat.filter((c) => c.startsWith("worktree remove"))).toHaveLength(2);
    expect(flat.findIndex((c) => c.startsWith("worktree remove"))).toBeLessThan(
      flat.findIndex((c) => c.startsWith("worktree add")),
    );
    expect(flat.some((c) => c.includes("feature/PROJ-202"))).toBe(false);
    expect(flat.some((c) => c.includes("feature/PROJ-203"))).toBe(false);
  });

  it("still retargets but skips the refresh when the dependent has a working task", async () => {
    seedDependent("PROJ-201", 43, "feature/PROJ-200");
    const task = queue4.enqueue({ type: "coding", issueId: "PROJ-201" });
    queue4.markWorking(task.id);

    await fireMerge();

    expect(sourceControl4.calls).toContain("updatePullRequestBase:43:main");
    const flat = gitCalls4.map((c) => c.args.join(" "));
    expect(flat.some((c) => c.startsWith("push"))).toBe(false);
    expect(flat.some((c) => c.includes("refresh-PROJ-201"))).toBe(false);
  });

  it("comments on the PR instead of pushing when the refresh merge conflicts", async () => {
    failOnMerge = true;
    seedDependent("PROJ-201", 43, "feature/PROJ-200");

    await fireMerge();

    const flat = gitCalls4.map((c) => c.args.join(" "));
    expect(flat.some((c) => c.startsWith("push"))).toBe(false);
    expect(flat.some((c) => c.startsWith("worktree remove"))).toBe(true);
    expect(sourceControl4.prComments).toHaveLength(1);
    expect(sourceControl4.prComments[0]?.prNumber).toBe(43);
    expect(sourceControl4.prComments[0]?.body).toContain("stack refresh");
  });

  it("skips done records with stale prNumbers — no lookup, no retarget", async () => {
    seedDependent("PROJ-205", 47, "feature/PROJ-200");
    pipelineState4.updatePhase("PROJ-205", "done");

    await fireMerge();

    expect(sourceControl4.calls).not.toContain("updatePullRequestBase:47:main");
  });

  it("tolerates a getPullRequest failure and keeps scanning", async () => {
    seedDependent("PROJ-201", 43, "feature/PROJ-200");
    seedDependent("PROJ-204", 46, "feature/PROJ-200");
    sourceControl4.getPullRequestThrowsFor.add(43);

    await fireMerge();

    expect(sourceControl4.calls).not.toContain("updatePullRequestBase:43:main");
    expect(sourceControl4.calls).toContain("updatePullRequestBase:46:main");
  });

  it("releases deferred tasks after the merge", async () => {
    const parked = queue4.enqueue({ type: "coding", issueId: "PROJ-300" });
    queue4.markDeferred(parked.id, ["PROJ-200"]);

    await fireMerge();

    expect(queue4.getTask(parked.id)?.status).toBe("ready");
  });

  it("serializes concurrent pr-merged scans — duplicate delivery refreshes once", async () => {
    seedDependent("PROJ-201", 43, "feature/PROJ-200");
    // Slow the PR lookup and snapshot its result so an unserialized second
    // scan captures the pre-retarget base and passes the base-match check —
    // the cascading-merge / duplicate-delivery race window.
    const orig = sourceControl4.getPullRequest.bind(sourceControl4);
    sourceControl4.getPullRequest = async (prNumber: number) => {
      const pr = await orig(prNumber);
      const snapshot = pr === null ? null : { ...pr };
      await new Promise((r) => setTimeout(r, 25));
      return snapshot;
    };

    const post = (): Promise<Response> =>
      fetch(`http://127.0.0.1:${String(port4)}/webhook/source-control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    await Promise.all([post(), post()]);
    await new Promise((r) => setTimeout(r, 200));

    const flat = gitCalls4.map((c) => c.args.join(" "));
    expect(flat.filter((c) => c.startsWith("push"))).toHaveLength(1);
    expect(sourceControl4.calls.filter((c) => c === "updatePullRequestBase:43:main")).toHaveLength(
      1,
    );
  });
});
