import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedQueenDatabase } from "../database.js";
import { SqliteTaskQueue } from "../queue.js";
import { PipelineStateStore, OrchestratorStateStore } from "../pipeline-state.js";
import { PhaseUsageStore } from "../phase-usage.js";
import { DualWriteAuditLogger } from "../audit.js";
import { buildPhaseGraph } from "../config.js";
import { DEFAULT_PHASES } from "../defaults.js";
import { RedQueen } from "../orchestrator.js";
import { RuntimeState } from "../runtime-state.js";
import type { WorkerOptions, WorkerResult } from "../worker.js";
import { MockIssueTracker, MockSourceControl, makeIssue } from "./fixtures/mock-adapters.js";
import { makeTestConfig } from "./fixtures/test-config.js";

let tempDir: string;
let dbPath: string;
let skillsDir: string;
let auditPath: string;

interface Harness {
  db: RedQueenDatabase;
  queue: SqliteTaskQueue;
  pipelineState: PipelineStateStore;
  issueTracker: MockIssueTracker;
  rq: RedQueen;
  runs: WorkerOptions[];
}

const okResult: WorkerResult = {
  success: true,
  exitCode: 0,
  elapsed: 1,
  summary: "done",
  error: null,
};

function setupHarness(
  workerImpl: (opts: WorkerOptions) => Promise<WorkerResult> = () => Promise.resolve(okResult),
): Harness {
  const db = new RedQueenDatabase(dbPath);
  const queue = new SqliteTaskQueue(db.db);
  const pipelineState = new PipelineStateStore(db.db);
  const phaseUsage = new PhaseUsageStore(db.db);
  const orchestratorState = new OrchestratorStateStore(db.db);
  const audit = new DualWriteAuditLogger(db.db, auditPath);
  const issueTracker = new MockIssueTracker();
  const sourceControl = new MockSourceControl();
  const config = makeTestConfig({
    project: {
      buildCommand: "npm run build",
      testCommand: "npm test",
      directory: tempDir,
    },
    skills: { directory: skillsDir, disabled: [] },
    dashboard: { enabled: false, port: 0, host: "127.0.0.1" },
    pipeline: {
      pollInterval: 0.01,
      maxRetries: 2,
      workerTimeout: 60,
      baseBranch: "main",
      branchPrefixes: { default: "feature/" },
      webhooks: { enabled: false },
      cost: { enabled: false, pricing: {} },
      agent: "claude-code",
      model: "opus",
      effort: "high",
      stallThresholdMs: 60_000,
      reconcileInterval: 0,
      claudeBin: "/bin/sh",
      skipSpecReviewIfReady: false,
    },
  });
  const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), config);

  const runs: WorkerOptions[] = [];
  const rq = new RedQueen({
    runtime,
    queue,
    pipelineState,
    phaseUsage,
    orchestratorState,
    audit,
    issueTracker,
    sourceControl,
    workerRunner: async (opts) => {
      runs.push(opts);
      return workerImpl(opts);
    },
    installSignalHandlers: false,
    sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });

  const harness: Harness = { db, queue, pipelineState, issueTracker, rq, runs };
  currentHarness = harness;
  return harness;
}

// Seed a dependent issue ready to run `coding` for the stack gate to evaluate.
function seedCodingIssue(h: Harness, issueId: string): string {
  h.issueTracker.issues.set(issueId, makeIssue(issueId, "coding"));
  h.issueTracker.phases.set(issueId, "coding");
  h.issueTracker.specs.set(issueId, "the spec");
  h.pipelineState.create(issueId, "coding");
  h.pipelineState.updateSpec(issueId, "the spec");
  const task = h.queue.enqueue({ type: "coding", issueId });
  return task.id;
}

// Park a blocker at the terminal human gate with a PR + branch (satisfied).
function seedBlockerAtGate(h: Harness, issueId: string, branch: string): void {
  h.issueTracker.phases.set(issueId, "human-review");
  h.pipelineState.create(issueId, "human-review");
  h.pipelineState.updateBranchInfo(issueId, { branchName: branch, prNumber: 42 });
}

async function runUntil(
  h: Harness,
  predicate: () => boolean,
  opts: { maxMs?: number } = {},
): Promise<void> {
  const maxMs = opts.maxMs ?? 2000;
  const startPromise = h.rq.start();
  const startTime = Date.now();
  while (Date.now() - startTime < maxMs) {
    await new Promise((r) => setTimeout(r, 10));
    if (predicate()) {
      break;
    }
  }
  await h.rq.stop();
  await startPromise.catch(() => {
    // Shutdown clears the main loop
  });
}

function readDispatchedPrompt(opts: WorkerOptions): string {
  const match = /Read and follow (.+) exactly\./.exec(opts.prompt);
  const path = match?.[1];
  if (path === undefined) {
    return "";
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

let currentHarness: Harness | null = null;

describe("orchestrator stack gate", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-stack-"));
    dbPath = join(tempDir, "redqueen.db");
    skillsDir = join(tempDir, "skills");
    auditPath = join(tempDir, "audit.log");
    mkdirSync(skillsDir, { recursive: true });
    for (const skill of ["prompt-writer", "coder", "reviewer", "tester", "comment-handler"]) {
      const dir = join(skillsDir, skill);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `# ${skill}\n`);
    }
    currentHarness = null;
  });

  afterEach(() => {
    if (currentHarness !== null) {
      try {
        currentHarness.db.close();
      } catch {
        // Already closed
      }
      currentHarness = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("defers when a blocker is unsatisfied — worker never launches, one comment across two evaluations", async () => {
    const h = setupHarness();
    const taskId = seedCodingIssue(h, "#2");
    h.issueTracker.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.issueTracker.phases.set("#1", "coding");

    let released = false;
    await runUntil(h, () => {
      const status = h.queue.getTask(taskId)?.status;
      if (status === "deferred" && released === false) {
        released = true;
        h.queue.releaseDeferred();
        return false;
      }
      return released && status === "deferred";
    });

    const task = h.queue.getTask(taskId);
    expect(task?.status).toBe("deferred");
    expect(task?.blockedOn).toEqual(["#1"]);
    expect(h.runs).toHaveLength(0);
    // Plain waits get one deduped comment — the ticket already reads
    // "assigned to AI" on the tracker, so the park must be visible there.
    const comments = h.issueTracker.commentsById.get("#2") ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Waiting on: #1");
  });

  it("dispatches with stack context when the blocker sits at the gate with a PR + branch", async () => {
    const prompts: string[] = [];
    const h = setupHarness((opts) => {
      prompts.push(readDispatchedPrompt(opts));
      return Promise.resolve(okResult);
    });
    seedCodingIssue(h, "#2");
    h.issueTracker.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    seedBlockerAtGate(h, "#1", "feature/1");

    await runUntil(h, () => prompts.length >= 1);

    const prompt = prompts[0] ?? "";
    expect(prompt).toContain("stackPrBase: feature/1");
    expect(prompt).toContain("stackBlockedBy:");
    expect(prompt).toContain("#1");
  });

  it("dispatches without stack context when the blocker is already done", async () => {
    const prompts: string[] = [];
    const h = setupHarness((opts) => {
      prompts.push(readDispatchedPrompt(opts));
      return Promise.resolve(okResult);
    });
    seedCodingIssue(h, "#2");
    h.issueTracker.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.pipelineState.create("#1", "done");

    await runUntil(h, () => prompts.length >= 1);

    const prompt = prompts[0] ?? "";
    expect(prompt).toContain('issueId: "#2"');
    expect(prompt).not.toContain("stackBlockedBy");
    expect(prompt).not.toContain("stackPrBase");
  });

  it("cycle defers with exactly one comment across two evaluations", async () => {
    const h = setupHarness();
    const taskId = seedCodingIssue(h, "#2");
    h.issueTracker.blockedBy.set("#2", [{ id: "#2", closed: false }]);

    let released = false;
    await runUntil(h, () => {
      const status = h.queue.getTask(taskId)?.status;
      if (status === "deferred" && released === false) {
        released = true;
        h.queue.releaseDeferred();
        return false;
      }
      return released && status === "deferred";
    });

    const task = h.queue.getTask(taskId);
    expect(task?.status).toBe("deferred");
    expect(task?.blockedOn).toEqual(["<cycle>"]);
    expect(h.runs).toHaveLength(0);
    const comments = h.issueTracker.commentsById.get("#2") ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("cycle");
  });

  it("releases parked work when a blocker advances to the terminal gate", async () => {
    const prompts: string[] = [];
    const h = setupHarness((opts) => {
      prompts.push(readDispatchedPrompt(opts));
      return Promise.resolve(okResult);
    });
    // Dependent #2 parks first (older pipeline row → dequeued first).
    seedCodingIssue(h, "#2");
    h.issueTracker.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    // Blocker #1 runs testing → advances to human-review (the terminal gate).
    h.issueTracker.issues.set("#1", makeIssue("#1", "testing"));
    h.issueTracker.phases.set("#1", "testing");
    h.pipelineState.create("#1", "testing");
    h.pipelineState.updateBranchInfo("#1", { branchName: "feature/1", prNumber: 7 });
    h.queue.enqueue({ type: "testing", issueId: "#1" });

    const dependentPrompt = (): string | undefined =>
      prompts.find((p) => p.includes('issueId: "#2"'));
    await runUntil(h, () => dependentPrompt() !== undefined);

    expect(h.issueTracker.phases.get("#1")).toBe("human-review");
    expect(dependentPrompt()).toContain("stackPrBase: feature/1");
    // The dependent parked before the blocker's gate arrival woke it.
    expect(prompts[0]).toContain('issueId: "#1"');
  });

  it("defers with <resolve-error> when the root dependency lookup fails", async () => {
    const h = setupHarness();
    const taskId = seedCodingIssue(h, "#2");
    h.issueTracker.getBlockedByThrowsFor.add("#2");

    await runUntil(h, () => h.queue.getTask(taskId)?.status === "deferred");

    const task = h.queue.getTask(taskId);
    expect(task?.status).toBe("deferred");
    expect(task?.blockedOn).toEqual(["<resolve-error>"]);
    expect(h.runs).toHaveLength(0);
  });

  it("resolve-error surfaces exactly one tracker comment across two evaluations", async () => {
    const h = setupHarness();
    const taskId = seedCodingIssue(h, "#2");
    h.issueTracker.getBlockedByThrowsFor.add("#2");

    let released = false;
    await runUntil(h, () => {
      const status = h.queue.getTask(taskId)?.status;
      if (status === "deferred" && released === false) {
        released = true;
        h.queue.releaseDeferred();
        return false;
      }
      return released && status === "deferred";
    });

    expect(h.queue.getTask(taskId)?.blockedOn).toEqual(["<resolve-error>"]);
    expect(h.runs).toHaveLength(0);
    const comments = h.issueTracker.commentsById.get("#2") ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("dependency resolution failed");
  });
});
