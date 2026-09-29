import { createSourceControlRegistry } from "../../integrations/source-control-registry.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedQueenDatabase } from "../database.js";
import { ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY } from "../assignment-router.js";
import { SqliteTaskQueue } from "../queue.js";
import { PipelineStateStore, OrchestratorStateStore } from "../pipeline-state.js";
import { PhaseUsageStore } from "../phase-usage.js";
import { DualWriteAuditLogger } from "../audit.js";
import type { AuditLogger, AuditEntry } from "../audit.js";
import { buildPhaseGraph } from "../config.js";
import type { RedQueenConfig } from "../config.js";
import { DEFAULT_PHASES } from "../defaults.js";
import type { PhaseDefinition } from "../types.js";
import { RedQueen } from "../orchestrator.js";
import type { RedQueenDeps } from "../orchestrator.js";
import { RuntimeState } from "../runtime-state.js";
import { reconcile } from "../reconciler.js";
import { resumePipeline } from "../pipeline-recovery.js";
import type { WorkerOptions, WorkerResult } from "../worker.js";
import { buildWorkerArgs } from "../worker.js";
import { MockIssueTracker, MockSourceControl, makeIssue } from "./fixtures/mock-adapters.js";
import { makeTestConfig } from "./fixtures/test-config.js";
import { makeWorkerResult } from "./fixtures/worker-result.js";

let tempDir: string;
let dbPath: string;
let skillsDir: string;
let auditPath: string;

interface Harness {
  runtime: RuntimeState;
  db: RedQueenDatabase;
  queue: SqliteTaskQueue;
  pipelineState: PipelineStateStore;
  phaseUsage: PhaseUsageStore;
  orchestratorState: OrchestratorStateStore;
  audit: DualWriteAuditLogger;
  issueTracker: MockIssueTracker;
  sourceControl: MockSourceControl;
  rq: RedQueen;
  runs: WorkerOptions[];
  workerImpl: (opts: WorkerOptions) => Promise<WorkerResult>;
}

interface HarnessOptions {
  extra?: Partial<RedQueenDeps>;
  skipSpecReviewIfReady?: boolean;
  phases?: PhaseDefinition[];
  pipeline?: Partial<RedQueenConfig["pipeline"]>;
  repos?: RedQueenConfig["project"]["repos"];
}

function setupHarness(
  workerImpl: (opts: WorkerOptions) => Promise<WorkerResult>,
  options: HarnessOptions = {},
): Harness {
  const db = new RedQueenDatabase(dbPath);
  const queue = new SqliteTaskQueue(db.db);
  const phaseUsage = new PhaseUsageStore(db.db);
  const orchestratorState = new OrchestratorStateStore(db.db);
  const audit = new DualWriteAuditLogger(db.db, auditPath);
  const issueTracker = new MockIssueTracker();
  const sourceControl = new MockSourceControl();
  const phaseGraph = buildPhaseGraph(options.phases ?? DEFAULT_PHASES);
  const config = makeTestConfig({
    project: {
      buildCommand: "npm run build",
      testCommand: "npm test",
      directory: tempDir,
      ...(options.repos === undefined ? {} : { repos: options.repos, workspaceMode: true }),
    },
    skills: { directory: skillsDir, disabled: [] },
    dashboard: { enabled: false, port: 0, host: "127.0.0.1" },
    pipeline: {
      pollInterval: 0.01,
      maxRetries: 2,
      workerTimeout: 60,
      baseBranch: "origin/main",
      branchPrefixes: { default: "feature/" },
      webhooks: { enabled: false },
      cost: { enabled: false, pricing: {} },
      agent: "claude-code",
      model: "opus",
      effort: "high",
      stallThresholdMs: 60_000,
      reconcileInterval: 0,
      claudeBin: "/bin/sh",
      skipSpecReviewIfReady: options.skipSpecReviewIfReady ?? false,
      ...(options.pipeline ?? {}),
    },
  });
  const pipelineState = new PipelineStateStore(
    db.db,
    config.project.repos.map((repo) => repo.name),
  );
  const runtime = new RuntimeState(phaseGraph, config);

  const runs: WorkerOptions[] = [];
  const wrappedWorker = async (opts: WorkerOptions): Promise<WorkerResult> => {
    runs.push(opts);
    return workerImpl(opts);
  };

  const rq = new RedQueen({
    runtime,
    queue,
    pipelineState,
    phaseUsage,
    orchestratorState,
    audit,
    issueTracker,
    sourceControls: createSourceControlRegistry([
      { name: "app", fullName: "acme/app", adapter: sourceControl },
    ]),
    workerRunner: wrappedWorker,
    installSignalHandlers: false,
    sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    ...(options.extra ?? {}),
  });

  const harness: Harness = {
    runtime,
    db,
    queue,
    pipelineState,
    phaseUsage,
    orchestratorState,
    audit,
    issueTracker,
    sourceControl,
    rq,
    runs,
    workerImpl,
  };
  currentHarness = harness;
  return harness;
}

function writeSkill(name: string): void {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`);
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

async function runUntilAfterRuns(h: Harness, count: number, maxMs = 2000): Promise<void> {
  await runUntil(h, () => h.runs.length >= count, { maxMs });
}

// The orchestrator writes the rendered skill prompt (the YAML context block) to a
// temp file and only passes the worker a "Read and follow <path> exactly." string.
// The file still exists while the worker runs, so read it back to inspect context.
function readDispatchedPrompt(opts: WorkerOptions): string | null {
  const match = /Read and follow (.+) exactly\./.exec(opts.prompt);
  const path = match?.[1];
  if (path === undefined) {
    return null;
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

let currentHarness: Harness | null = null;

describe("RedQueen orchestrator", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-orch-"));
    dbPath = join(tempDir, "redqueen.db");
    skillsDir = join(tempDir, "skills");
    auditPath = join(tempDir, "audit.log");
    mkdirSync(skillsDir, { recursive: true });
    // Write SKILL.md for every skill referenced by default phases
    writeSkill("prompt-writer");
    writeSkill("coder");
    writeSkill("reviewer");
    writeSkill("tester");
    writeSkill("comment-handler");
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

  it.each([
    { mode: "legacy", mapExists: true },
    { mode: "legacy", mapExists: false },
    { mode: "workspace", mapExists: true },
    { mode: "workspace", mapExists: false },
  ])(
    "passes codebaseMapPath from the project root in $mode mode (map exists: $mapExists)",
    async ({ mode, mapExists }) => {
      const mapPath = join(tempDir, ".redqueen", "codebase-map.md");
      if (mapExists) {
        mkdirSync(join(tempDir, ".redqueen"), { recursive: true });
        writeFileSync(mapPath, "# Project map\n");
      }

      const options: HarnessOptions = {};
      if (mode === "workspace") {
        const repoPath = join(tempDir, "app");
        options.repos = makeTestConfig({ project: { directory: repoPath } }).project.repos;
        // A repo-local map must never replace the workspace-root map.
        mkdirSync(join(repoPath, ".redqueen"), { recursive: true });
        writeFileSync(join(repoPath, ".redqueen", "codebase-map.md"), "# Repo map\n");
      }

      let capturedPrompt: string | null = null;
      const h = setupHarness((opts) => {
        capturedPrompt = readDispatchedPrompt(opts);
        return Promise.resolve(
          makeWorkerResult({ success: true, exitCode: 0, elapsed: 1, summary: "ok", error: null }),
        );
      }, options);
      h.pipelineState.create("PROJ-MAP", "spec-writing");
      h.issueTracker.phases.set("PROJ-MAP", "spec-writing");
      h.issueTracker.specs.set("PROJ-MAP", "spec");
      h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-MAP" });

      await runUntilAfterRuns(h, 1);

      expect(capturedPrompt).toContain(`codebaseMapPath: ${mapExists ? mapPath : "null"}`);
    },
  );

  it.each([
    { mode: "legacy", expected: "# prompt-writer\n" },
    { mode: "workspace", expected: "# prompt-writer-workspace\n" },
  ])("dispatches the $mode prompt for a phase's skill", async ({ mode, expected }) => {
    writeSkill("prompt-writer-workspace");
    const options: HarnessOptions = {};
    if (mode === "workspace") {
      options.repos = makeTestConfig({
        project: { directory: join(tempDir, "app") },
      }).project.repos;
    }

    let capturedPrompt: string | null = null;
    const h = setupHarness((opts) => {
      capturedPrompt = readDispatchedPrompt(opts);
      return Promise.resolve(
        makeWorkerResult({ success: true, exitCode: 0, elapsed: 1, summary: "ok", error: null }),
      );
    }, options);
    h.pipelineState.create("PROJ-MODE", "spec-writing");
    h.issueTracker.phases.set("PROJ-MODE", "spec-writing");
    h.issueTracker.specs.set("PROJ-MODE", "spec");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-MODE" });

    await runUntilAfterRuns(h, 1);

    expect(capturedPrompt).toMatch(/```\n\n# prompt-writer(-workspace)?\n$/);
    expect(capturedPrompt).toContain(expected);
    expect(capturedPrompt).not.toContain(
      mode === "workspace" ? "# prompt-writer\n" : "# prompt-writer-workspace\n",
    );
  });

  it("processes a task end-to-end and advances phase", async () => {
    // Worker fails on subsequent runs so we don't cascade through the whole pipeline
    let runCount = 0;
    const phasesSeen: (string | null)[] = [];
    const h = setupHarness(() => {
      runCount++;
      phasesSeen.push(h.issueTracker.phases.get("PROJ-1") ?? null);
      if (runCount === 1) {
        return Promise.resolve(
          makeWorkerResult({
            success: true,
            exitCode: 0,
            elapsed: 1,
            summary: "done",
            error: null,
          }),
        );
      }
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 0,
          summary: "",
          error: "stop cascade",
        }),
      );
    });
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec body.");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });

    await runUntil(h, () => runCount >= 2);

    // The first run saw coding phase; orchestrator advanced to code-review after
    expect(phasesSeen[0]).toBe("coding");
    expect(phasesSeen[1]).toBe("code-review");
  });

  it("dispatches coding as review-rework after code-review fails", async () => {
    const prompts: string[] = [];
    const h = setupHarness((opts) => {
      const content = readDispatchedPrompt(opts);
      if (content !== null) {
        prompts.push(content);
        if (content.includes("phaseName: coding")) {
          void h.rq.stop();
        }
      }
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 0,
          summary: "",
          error: "blockers",
          usage: null,
        }),
      );
    });
    h.pipelineState.create("PROJ-RW1", "code-review");
    h.issueTracker.phases.set("PROJ-RW1", "code-review");
    h.issueTracker.specs.set("PROJ-RW1", "Implementation spec body.");
    h.queue.enqueue({ type: "code-review", issueId: "PROJ-RW1" });

    await runUntil(
      h,
      () =>
        h.pipelineState.get("PROJ-RW1")?.currentPhase === "coding" &&
        prompts.some((c) => c.includes("phaseName: coding")),
    );

    const record = h.pipelineState.get("PROJ-RW1");
    expect(record?.currentPhase).toBe("coding");
    expect(record?.priorPhase).toBe("code-review");
    expect(record?.reviewIterations).toBe(1);

    // The coder dispatch must carry the rework signal and the correct round.
    const codingPrompt = prompts.find((c) => c.includes("phaseName: coding"));
    expect(codingPrompt).toContain("priorPhase: code-review");
    expect(codingPrompt).toContain("iterationCount: 1");
  });

  it("dispatches coding as test-rework after testing fails", async () => {
    const prompts: string[] = [];
    const h = setupHarness((opts) => {
      const content = readDispatchedPrompt(opts);
      if (content !== null) {
        prompts.push(content);
        if (content.includes("phaseName: coding")) {
          void h.rq.stop();
        }
      }
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 0,
          summary: "",
          error: "tests failed",
          usage: null,
        }),
      );
    });
    h.pipelineState.create("PROJ-RW2", "testing");
    h.issueTracker.phases.set("PROJ-RW2", "testing");
    h.issueTracker.specs.set("PROJ-RW2", "Implementation spec body.");
    h.queue.enqueue({ type: "testing", issueId: "PROJ-RW2" });

    await runUntil(
      h,
      () =>
        h.pipelineState.get("PROJ-RW2")?.currentPhase === "coding" &&
        prompts.some((c) => c.includes("phaseName: coding")),
    );

    expect(h.pipelineState.get("PROJ-RW2")?.priorPhase).toBe("testing");
    const codingPrompt = prompts.find((c) => c.includes("phaseName: coding"));
    expect(codingPrompt).toContain("priorPhase: testing");
  });

  it("dispatches a fresh coding task with priorPhase null", async () => {
    const prompts: string[] = [];
    const h = setupHarness((opts) => {
      const content = readDispatchedPrompt(opts);
      if (content !== null) {
        prompts.push(content);
      }
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 0,
          summary: "",
          error: "stop cascade",
          usage: null,
        }),
      );
    });
    h.pipelineState.create("PROJ-RW3", "coding");
    h.issueTracker.phases.set("PROJ-RW3", "coding");
    h.issueTracker.specs.set("PROJ-RW3", "Implementation spec body.");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-RW3" });

    await runUntil(h, () => prompts.some((c) => c.includes("phaseName: coding")));

    const codingPrompt = prompts.find((c) => c.includes("phaseName: coding"));
    expect(codingPrompt).toContain("priorPhase: null");
  });

  it("skips stale task when issue is at human gate", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    h.pipelineState.create("PROJ-1", "coding");
    // Issue is actually in spec-review (human gate) — stale task
    h.issueTracker.phases.set("PROJ-1", "spec-review");
    const task = h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "complete");

    // Worker must not have run for this task
    expect(h.runs.length).toBe(0);
    const storedTask = h.queue.getTask(task.id);
    expect(storedTask?.status).toBe("complete");
    expect(storedTask?.result).toContain("Stale");
  });

  it("retries on failure up to maxRetries", async () => {
    let attempts = 0;
    const h = setupHarness(() => {
      attempts++;
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 1,
          summary: "",
          error: "boom",
        }),
      );
    });
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec body.");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });

    await runUntilAfterRuns(h, 3, 3000);

    // Initial + 2 retries = 3 total attempts
    expect(attempts).toBe(3);
    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("blocked");
    expect(h.issueTracker.phases.get("PROJ-1")).toBe("blocked");
    expect(h.issueTracker.calls).toContain("assignToHuman:PROJ-1:none");
    expect(h.queue.hasOpenTask("PROJ-1", "coding")).toBe(false);
    const notices = h.issueTracker.commentsById.get("PROJ-1") ?? [];
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain("3 attempts");
  });

  it("keeps an unrouted failure stopped across sweeps and restart until explicit re-entry", async () => {
    const phases = DEFAULT_PHASES.map((phase) =>
      phase.name === "coding" ? { ...phase, escalateTo: undefined, next: "human-review" } : phase,
    );
    const h = setupHarness(
      () =>
        Promise.resolve(makeWorkerResult({ success: false, exitCode: 1, error: "launch failed" })),
      { phases },
    );
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec body.");
    h.issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);

    await runUntil(h, () => h.pipelineState.isPhaseExhausted("PROJ-1", "coding"));

    expect(h.runs).toHaveLength(3);
    expect(h.queue.listByStatus("failed")).toHaveLength(3);
    expect(h.issueTracker.commentsById.get("PROJ-1")).toHaveLength(1);
    expect(h.issueTracker.assignments.get("PROJ-1")).toBe("human");
    for (let sweep = 0; sweep < 3; sweep++) {
      expect((await reconcile(h)).tasksCreated).toBe(0);
    }
    h.db.close();

    const restarted = setupHarness(() => Promise.resolve(makeWorkerResult()), { phases });
    restarted.issueTracker.phases.set("PROJ-1", "coding");
    restarted.issueTracker.specs.set("PROJ-1", "Implementation spec body.");
    restarted.issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);
    // Purging old task history must not grant a new worker retry budget.
    restarted.db.db.exec("UPDATE tasks SET completed_at = '2000-01-01T00:00:00.000Z'");
    expect(restarted.queue.purgeOld(1)).toBe(3);
    await runUntil(restarted, () => true);
    expect(restarted.runs).toHaveLength(0);
    expect(restarted.queue.getOpenCount().ready).toBe(0);
    restarted.db.close();

    const reentered = setupHarness(() => Promise.resolve(makeWorkerResult()), { phases });
    reentered.issueTracker.phases.set("PROJ-1", "coding");
    reentered.issueTracker.specs.set("PROJ-1", "Implementation spec body.");
    reentered.queue.enqueue({ type: "coding", issueId: "PROJ-1", description: "Human re-entry" });
    await runUntil(
      reentered,
      () => reentered.pipelineState.get("PROJ-1")?.currentPhase === "human-review",
    );
    expect(reentered.runs).toHaveLength(1);
    expect(reentered.pipelineState.isPhaseExhausted("PROJ-1", "coding")).toBe(false);
  });

  it("keeps failed escalation stopped across sweeps, history purge, and restart", async () => {
    const h = setupHarness(() =>
      Promise.resolve(makeWorkerResult({ success: false, error: "boom" })),
    );
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec");
    h.issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);
    h.issueTracker.setPhaseFailures.add("blocked");
    await runUntil(h, () => h.pipelineState.getPendingTransition("PROJ-1") !== null);
    expect(h.runs).toHaveLength(3);
    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("coding");
    expect(h.pipelineState.isPhaseExhausted("PROJ-1", "coding")).toBe(true);
    expect(h.issueTracker.commentsById.get("PROJ-1")).toHaveLength(1);
    expect(h.issueTracker.commentsById.get("PROJ-1")?.[0]?.body).toContain("has not completed");
    for (let i = 0; i < 3; i++) {
      expect((await reconcile(h)).tasksCreated).toBe(0);
    }
    h.db.db.exec("UPDATE tasks SET completed_at = '2000-01-01T00:00:00.000Z'");
    expect(h.queue.purgeOld(1)).toBe(3);
    h.db.close();

    const restarted = setupHarness(() => Promise.resolve(makeWorkerResult()));
    restarted.issueTracker.phases.set("PROJ-1", "coding");
    restarted.issueTracker.specs.set("PROJ-1", "Implementation spec");
    restarted.issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);
    restarted.issueTracker.setPhaseFailures.add("blocked");
    await runUntil(restarted, () => true);
    expect(restarted.runs).toHaveLength(0);
    expect(restarted.queue.listByStatus("ready")).toHaveLength(0);
    restarted.issueTracker.setPhaseFailures.clear();
    restarted.issueTracker.listByPhaseResults.clear();
    const retryAt = restarted.pipelineState.getPendingTransition("PROJ-1")?.phaseRetryAt;
    const now = vi.spyOn(Date, "now").mockReturnValue(retryAt ?? Date.now());
    try {
      await reconcile(restarted);
    } finally {
      now.mockRestore();
    }
    expect(restarted.pipelineState.get("PROJ-1")?.currentPhase).toBe("blocked");
    expect(restarted.issueTracker.phases.get("PROJ-1")).toBe("blocked");
    expect(restarted.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
    expect(restarted.runs).toHaveLength(0);
  });

  it("does not post a destination notice after a failure handoff is cancelled", async () => {
    const h = setupHarness(
      () => {
        h.issueTracker.phases.set("PROJ-1", "spec-review");
        return Promise.resolve(makeWorkerResult({ success: false, error: "worker failed" }));
      },
      { pipeline: { maxRetries: 0 } },
    );
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });
    await runUntil(h, () => h.pipelineState.get("PROJ-1")?.currentPhase === "spec-review");
    expect(h.runs).toHaveLength(1);
    expect(h.issueTracker.phases.get("PROJ-1")).toBe("spec-review");
    expect(h.pipelineState.getPendingTransition("PROJ-1")).toBeNull();
    expect(h.issueTracker.commentsById.get("PROJ-1") ?? []).toHaveLength(0);
  });

  it("handles human PR feedback queued during Testing after arriving at Human Review", async () => {
    const executed: string[] = [];
    let feedbackId: string | undefined;
    let staleId: string | undefined;
    const h = setupHarness((options) => {
      const prompt = readDispatchedPrompt(options) ?? "";
      if (prompt.includes("phaseName: testing")) {
        executed.push("testing");
        staleId = h.queue.enqueue({ type: "testing", issueId: "PROJ-1" }).id;
        feedbackId = h.queue.enqueue({
          type: "code-feedback",
          issueId: "PROJ-1",
          description: "PR feedback",
          metadata: { trigger: "pr-feedback" },
        }).id;
      } else if (prompt.includes("phaseName: code-feedback")) {
        executed.push("code-feedback");
        void h.rq.stop();
      }
      return Promise.resolve(makeWorkerResult());
    });
    h.pipelineState.create("PROJ-1", "testing");
    h.pipelineState.updatePrNumber("PROJ-1", "app", 42, null);
    h.issueTracker.phases.set("PROJ-1", "testing");
    h.queue.enqueue({ type: "testing", issueId: "PROJ-1" });
    await runUntil(h, () => executed.includes("code-feedback"));
    expect(executed).toEqual(["testing", "code-feedback"]);
    expect(h.queue.getTask(staleId ?? "")?.status).toBe("cancelled");
    expect(h.queue.getTask(feedbackId ?? "")?.status).toBe("complete");
    const gateArrival = h.issueTracker.calls.indexOf("setPhase:PROJ-1:human-review");
    expect(gateArrival).toBeGreaterThanOrEqual(0);
    expect(h.issueTracker.calls.indexOf("setPhase:PROJ-1:code-feedback")).toBeGreaterThan(
      gateArrival,
    );
  });

  it("preserves exhaustion when a task is cancelled during its dispatch guards", async () => {
    const h = setupHarness(() => Promise.resolve(makeWorkerResult()));
    h.pipelineState.create("PROJ-1", "coding");
    h.pipelineState.setExhaustedPhase("PROJ-1", "coding");
    h.pipelineState.incrementReviewIterations("PROJ-1");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec");
    const task = h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });
    vi.spyOn(h.issueTracker, "getBlockedBy").mockImplementation(() => {
      h.queue.cancelPendingForIssue("PROJ-1", "Cancelled during guard");
      return Promise.resolve([]);
    });
    await runUntil(h, () => h.queue.getTask(task.id)?.status === "cancelled");
    expect(h.runs).toHaveLength(0);
    expect(h.pipelineState.isPhaseExhausted("PROJ-1", "coding")).toBe(true);
    expect(h.pipelineState.get("PROJ-1")?.reviewIterations).toBe(1);
  });

  it("defers explicit work while a phase write is pending instead of consuming it", async () => {
    const h = setupHarness(() => Promise.resolve(makeWorkerResult()));
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.pipelineState.beginPhaseTransition("PROJ-1", "coding", "blocked");
    h.issueTracker.setPhaseFailures.add("blocked");
    const task = h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });
    await runUntil(h, () => h.queue.getTask(task.id)?.status === "deferred");
    expect(h.runs).toHaveLength(0);
    expect(h.queue.getTask(task.id)?.status).toBe("deferred");
    expect(h.pipelineState.getPendingTransition("PROJ-1")).not.toBeNull();
  });

  it.each(["binary", "skill", "read", "temp-write"])(
    "bounds %s setup failures across sweeps and restart",
    async (failure) => {
      const phases = DEFAULT_PHASES.map((phase) =>
        phase.name === "coding" ? { ...phase, escalateTo: undefined } : phase,
      );
      const h = setupHarness(() => Promise.resolve(makeWorkerResult()), { phases });
      h.pipelineState.create("PROJ-1", "coding", "human-1");
      h.issueTracker.phases.set("PROJ-1", "coding");
      h.issueTracker.specs.set("PROJ-1", "Implementation spec");
      h.issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);
      if (failure === "binary") {
        h.runtime.config.pipeline.claudeBin = join(tempDir, "missing-binary");
      } else if (failure === "skill") {
        h.runtime.config.skills.disabled.push("coder");
      } else if (failure === "read") {
        rmSync(join(skillsDir, "coder", "SKILL.md"));
        mkdirSync(join(skillsDir, "coder", "SKILL.md"));
      } else {
        mkdirSync(join(tempDir, ".redqueen"), { recursive: true });
        writeFileSync(join(tempDir, ".redqueen", "tmp"), "not a directory");
      }
      await runUntil(h, () => h.pipelineState.isPhaseExhausted("PROJ-1", "coding"));
      expect(h.runs).toHaveLength(0);
      expect(h.queue.listByStatus("failed")).toHaveLength(3);
      expect(h.issueTracker.commentsById.get("PROJ-1")).toHaveLength(1);
      expect(h.issueTracker.commentsById.get("PROJ-1")?.[0]?.body).toContain(
        "redqueen pipeline resume PROJ-1",
      );
      expect(h.issueTracker.calls).toContain("assignToHuman:PROJ-1:human-1");
      for (let i = 0; i < 3; i++) {
        expect((await reconcile(h)).tasksCreated).toBe(0);
      }
      h.db.close();
      const restarted = setupHarness(() => Promise.resolve(makeWorkerResult()), { phases });
      restarted.issueTracker.phases.set("PROJ-1", "coding");
      restarted.issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-1", "coding")]);
      await runUntil(restarted, () => true);
      expect(restarted.runs).toHaveLength(0);
      expect(restarted.queue.listByStatus("ready")).toHaveLength(0);
    },
  );

  it("sends reviewer setup failure to a human instead of cycling through coding", async () => {
    const h = setupHarness(() => Promise.resolve(makeWorkerResult()));
    h.runtime.config.skills.disabled.push("reviewer");
    h.pipelineState.create("PROJ-1", "code-review");
    h.issueTracker.phases.set("PROJ-1", "code-review");
    h.queue.enqueue({ type: "code-review", issueId: "PROJ-1" });
    await runUntil(h, () => h.issueTracker.phases.get("PROJ-1") === "human-review");
    expect(h.runs).toHaveLength(0);
    expect(h.queue.listByStatus("failed")).toHaveLength(3);
    expect(h.queue.hasOpenTask("PROJ-1", "coding")).toBe(false);
  });

  it("bounds testing rework even when every intermediate code review passes", async () => {
    let testingRuns = 0;
    const h = setupHarness((opts) => {
      const testing = readDispatchedPrompt(opts)?.includes("phaseName: testing") === true;
      if (testing) {
        testingRuns++;
      }
      return Promise.resolve(
        makeWorkerResult({
          success: testing === false,
          exitCode: testing ? 1 : 0,
          error: testing ? "tests failed" : null,
        }),
      );
    });
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });
    await runUntil(h, () => h.issueTracker.phases.get("PROJ-1") === "human-review");
    expect(testingRuns).toBe(12);
    expect(h.runs).toHaveLength(20);
    expect(h.queue.getOpenCount().ready).toBe(0);
    expect(h.issueTracker.commentsById.get("PROJ-1")).toHaveLength(1);
  });

  it("routes code-review failure straight to coding without crash-retries", async () => {
    const prompts: string[] = [];
    const h = setupHarness((opts) => {
      const content = readDispatchedPrompt(opts);
      if (content !== null) {
        prompts.push(content);
        if (content.includes("phaseName: coding")) {
          void h.rq.stop();
        }
      }
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 0,
          summary: "",
          error: "blockers",
          usage: null,
        }),
      );
    });
    h.pipelineState.create("PROJ-NR", "code-review");
    h.issueTracker.phases.set("PROJ-NR", "code-review");
    h.issueTracker.specs.set("PROJ-NR", "Implementation spec body.");
    h.queue.enqueue({ type: "code-review", issueId: "PROJ-NR" });

    await runUntil(h, () => prompts.some((c) => c.includes("phaseName: coding")));

    // maxRetries is 2, but code-review opts out of crash-retries: a request-changes
    // exit dispatches the reviewer exactly once, then routes to coding for rework.
    const reviewRuns = prompts.filter((c) => c.includes("phaseName: code-review")).length;
    expect(reviewRuns).toBe(1);
    expect(h.pipelineState.get("PROJ-NR")?.currentPhase).toBe("coding");
  });

  it("respects agent-changed phase", async () => {
    let runCount = 0;
    const h = setupHarness(() => {
      runCount++;
      if (runCount === 1) {
        // First run: simulate agent changing phase to "coding"
        h.issueTracker.phases.set("PROJ-1", "coding");
        void h.rq.stop();
        return Promise.resolve(
          makeWorkerResult({
            success: true,
            exitCode: 0,
            elapsed: 1,
            summary: "returned to coding",
            error: null,
          }),
        );
      }
      // Subsequent runs fail so the pipeline halts after the second run
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 0,
          summary: "",
          error: "halt cascade",
        }),
      );
    });
    h.pipelineState.create("PROJ-1", "code-review");
    h.issueTracker.phases.set("PROJ-1", "code-review");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec body.");
    h.queue.enqueue({ type: "code-review", issueId: "PROJ-1" });

    // The orchestrator should respect the agent-changed phase and move pipeline state to coding
    await runUntil(h, () => h.pipelineState.get("PROJ-1")?.currentPhase === "coding");

    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("coding");
  });

  it("processes new-ticket tasks without a worker", async () => {
    // Snapshot tracker state on the FIRST worker invocation — at that point
    // new-ticket is complete and we're still at spec-writing+ai (the worker
    // hasn't advanced the phase yet). Subsequent worker runs would overwrite
    // the snapshot, so we freeze it after the first capture.
    const snapshot: { phase: string | null; assignment: string | null } = {
      phase: null,
      assignment: null,
    };
    let captured = false;
    const h = setupHarness(() => {
      if (captured === false) {
        snapshot.phase = h.issueTracker.phases.get("PROJ-1") ?? null;
        snapshot.assignment = h.issueTracker.assignments.get("PROJ-1") ?? null;
        captured = true;
      }
      return Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 0,
          summary: "",
          error: null,
        }),
      );
    });
    h.queue.enqueue({ type: "new-ticket", issueId: "PROJ-1" });

    // Run until the worker ran at least once — that's our snapshot point.
    await runUntil(h, () => h.runs.length >= 1);

    expect(snapshot.phase).toBe("spec-writing");
    expect(snapshot.assignment).toBe("ai");
  });

  it("routes a phase added while new-ticket waited without resetting it", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 0,
          summary: "",
          error: null,
        }),
      ),
    );
    const issue = makeIssue("PROJ-1", "spec-writing");
    h.issueTracker.issues.set(issue.id, issue);
    h.issueTracker.phases.set(issue.id, "spec-writing");
    h.queue.enqueue({ type: "new-ticket", issueId: issue.id });

    await runUntil(h, () => h.runs.length >= 1);

    expect(h.issueTracker.calls).not.toContain("setPhase:PROJ-1:spec-writing");
    expect(h.pipelineState.get(issue.id)).not.toBeNull();
  });

  it("does not reset a ticket moved to a human gate while new-ticket waited", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 0,
          summary: "should not run",
          error: null,
        }),
      ),
    );
    const task = h.queue.enqueue({ type: "new-ticket", issueId: "PROJ-1" });
    h.issueTracker.phases.set("PROJ-1", "spec-review");

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "complete");

    expect(h.issueTracker.calls.some((call) => call.startsWith("setPhase:PROJ-1:"))).toBe(false);
    expect(h.pipelineState.get("PROJ-1")).toBeNull();
    expect(h.runs).toHaveLength(0);
  });

  it("fails closed when new-ticket cannot revalidate a human-gate phase", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 0,
          summary: "should not run",
          error: null,
        }),
      ),
    );
    const task = h.queue.enqueue({ type: "new-ticket", issueId: "PROJ-PHASE-ERROR" });
    h.issueTracker.phases.set("PROJ-PHASE-ERROR", "spec-review");
    h.issueTracker.getPhaseThrowsFor.add("PROJ-PHASE-ERROR");

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "failed");

    expect(h.issueTracker.calls.some((call) => call.startsWith("setPhase:PROJ-PHASE-ERROR:"))).toBe(
      false,
    );
    expect(h.issueTracker.calls).not.toContain("assignToAi:PROJ-PHASE-ERROR");
    expect(h.pipelineState.get("PROJ-PHASE-ERROR")).toBeNull();
    expect(h.runs).toHaveLength(0);
  });

  it("parks a recovered new-ticket after its AI assignment is revoked", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 0,
          summary: "should not run",
          error: null,
        }),
      ),
    );
    const task = h.queue.enqueue({
      type: "new-ticket",
      issueId: "PROJ-REVOKED",
      metadata: { [ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY]: true },
    });
    h.issueTracker.assignments.set("PROJ-REVOKED", "human");

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "deferred");

    expect(h.queue.getTask(task.id)?.blockedOn).toEqual(["<ai-assignment-required>"]);
    expect(h.issueTracker.calls.some((call) => call.startsWith("setPhase:PROJ-REVOKED:"))).toBe(
      false,
    );
    expect(h.issueTracker.calls).not.toContain("assignToAi:PROJ-REVOKED");
    expect(h.pipelineState.get("PROJ-REVOKED")).toBeNull();
    expect(h.runs).toHaveLength(0);
  });

  it("defers a recovered task when live assignment state cannot be read", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 0,
          summary: "should not run",
          error: null,
        }),
      ),
    );
    const task = h.queue.enqueue({
      type: "new-ticket",
      issueId: "PROJ-CLAIM-ERROR",
      metadata: { [ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY]: true },
    });
    h.issueTracker.assignments.set("PROJ-CLAIM-ERROR", "ai");
    h.issueTracker.getPhaseThrowsFor.add("PROJ-CLAIM-ERROR");

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "deferred");

    expect(h.queue.getTask(task.id)?.blockedOn).toEqual(["<assignment-check-error>"]);
    expect(h.issueTracker.calls.some((call) => call.startsWith("setPhase:PROJ-CLAIM-ERROR:"))).toBe(
      false,
    );
    expect(h.issueTracker.calls).not.toContain("assignToAi:PROJ-CLAIM-ERROR");
    expect(h.pipelineState.get("PROJ-CLAIM-ERROR")).toBeNull();
    expect(h.runs).toHaveLength(0);
  });

  it("parks a saved resume after assignment fails and runs it after a human repairs ownership", async () => {
    const h = setupHarness(() => {
      void h.rq.stop();
      return Promise.resolve(makeWorkerResult());
    });
    h.pipelineState.create("PROJ-1", "coding");
    h.pipelineState.setExhaustedPhase("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec");
    h.issueTracker.assignments.set("PROJ-1", "human");
    const assign = vi.spyOn(h.issueTracker, "assignToAi").mockRejectedValue(new Error("denied"));
    await expect(
      resumePipeline({ ...h, phaseGraph: h.runtime.phaseGraph }, "PROJ-1"),
    ).rejects.toThrow("was saved, but AI assignment failed");
    const task = h.queue.listByStatus("ready")[0];
    if (task === undefined) {
      throw new Error("Resume task was not saved");
    }

    const running = h.rq.start();
    try {
      await expect.poll(() => h.queue.getTask(task.id)?.status).toBe("deferred");
      expect(h.runs).toHaveLength(0);
      expect(h.queue.getTask(task.id)?.blockedOn).toEqual(["<ai-assignment-required>"]);
      assign.mockRestore();
      await h.issueTracker.assignToAi("PROJ-1");
      h.queue.releaseDeferred();

      await expect.poll(() => h.queue.getTask(task.id)?.status).toBe("complete");

      expect(h.runs).toHaveLength(1);
    } finally {
      await h.rq.stop();
      await running;
    }
  });

  it("performs crash recovery for working tasks", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    // Simulate a crashed state: task is "working", orchestrator state also working
    const task = h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });
    h.queue.markWorking(task.id);
    h.orchestratorState.setStatus("working");
    h.orchestratorState.setCurrentTaskId(task.id);
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec body.");

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "complete");

    // Task got re-queued and processed
    const stored = h.queue.getTask(task.id);
    expect(stored?.status).toBe("complete");
  });

  it("recovers a working task the current_task_id pointer never named", async () => {
    // Regression: a crash between markWorking and setCurrentTaskId leaves a
    // "working" task the pointer never named. Pointer-based recovery skipped it
    // and reconcile then saw hasOpenTask=true, stranding the issue forever.
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    const task = h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });
    h.queue.markWorking(task.id);
    // Crash gap: neither the status nor the pointer was written.
    h.orchestratorState.setCurrentTaskId(null);
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec body.");

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "complete");

    expect(h.queue.getTask(task.id)?.status).toBe("complete");
  });

  it("assigns to human when advancing to human gate", async () => {
    // spec-writing -> spec-review (human). spec-writing succeeds and the
    // orchestrator parks the ticket at the spec-review human gate.
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    h.pipelineState.create("PROJ-1", "spec-writing");
    h.issueTracker.phases.set("PROJ-1", "spec-writing");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec body.");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-1" });

    await runUntil(h, () => h.issueTracker.assignments.get("PROJ-1") === "human");

    expect(h.issueTracker.phases.get("PROJ-1")).toBe("spec-review");
    expect(h.issueTracker.assignments.get("PROJ-1")).toBe("human");
    expect(h.queue.hasOpenTask("PROJ-1", "spec-review")).toBe(false);
  });

  it("skipSpecReviewIfReady: skips spec-review gate when 0 open questions", async () => {
    // First worker run (spec-writing) succeeds — the rest fail to stop the
    // cascade so the ticket parks at whatever phase the skip-gate logic
    // landed it in.
    let runCount = 0;
    const h = setupHarness(
      () => {
        runCount += 1;
        if (runCount === 1) {
          return Promise.resolve(
            makeWorkerResult({
              success: true,
              exitCode: 0,
              elapsed: 1,
              summary: "spec written",
              error: null,
            }),
          );
        }
        return Promise.resolve(
          makeWorkerResult({
            success: false,
            exitCode: 1,
            elapsed: 1,
            summary: "",
            error: "stop cascade",
          }),
        );
      },
      { skipSpecReviewIfReady: true },
    );
    h.pipelineState.create("PROJ-SKIP", "spec-writing");
    h.pipelineState.setOpenQuestionCount("PROJ-SKIP", 0);
    h.issueTracker.phases.set("PROJ-SKIP", "spec-writing");
    h.issueTracker.specs.set("PROJ-SKIP", "Implementation spec body.");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-SKIP" });

    await runUntil(h, () => h.issueTracker.calls.includes("setPhase:PROJ-SKIP:coding"));

    // Skipped straight from spec-writing to coding; spec-review never set.
    expect(h.issueTracker.calls).toContain("setPhase:PROJ-SKIP:coding");
    expect(h.issueTracker.calls).not.toContain("setPhase:PROJ-SKIP:spec-review");
    // The count is consumed and cleared so a stale value can't fire again.
    expect(h.pipelineState.get("PROJ-SKIP")?.openQuestionCount).toBeNull();
  });

  it("skipSpecReviewIfReady: holds at spec-review when there are open questions", async () => {
    const h = setupHarness(
      () =>
        Promise.resolve(
          makeWorkerResult({
            success: true,
            exitCode: 0,
            elapsed: 1,
            summary: "spec written",
            error: null,
          }),
        ),
      { skipSpecReviewIfReady: true },
    );
    h.pipelineState.create("PROJ-HOLD", "spec-writing");
    h.pipelineState.setOpenQuestionCount("PROJ-HOLD", 2);
    h.issueTracker.phases.set("PROJ-HOLD", "spec-writing");
    h.issueTracker.specs.set("PROJ-HOLD", "Implementation spec body.");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-HOLD" });

    await runUntil(h, () => h.issueTracker.assignments.get("PROJ-HOLD") === "human");

    expect(h.issueTracker.phases.get("PROJ-HOLD")).toBe("spec-review");
    expect(h.issueTracker.assignments.get("PROJ-HOLD")).toBe("human");
    // Count survives — it was not consumed for routing.
    expect(h.pipelineState.get("PROJ-HOLD")?.openQuestionCount).toBe(2);
  });

  it("skipSpecReviewIfReady=false: never skips even when 0 open questions", async () => {
    const h = setupHarness(
      () =>
        Promise.resolve(
          makeWorkerResult({
            success: true,
            exitCode: 0,
            elapsed: 1,
            summary: "spec written",
            error: null,
          }),
        ),
      { skipSpecReviewIfReady: false },
    );
    h.pipelineState.create("PROJ-OFF", "spec-writing");
    h.pipelineState.setOpenQuestionCount("PROJ-OFF", 0);
    h.issueTracker.phases.set("PROJ-OFF", "spec-writing");
    h.issueTracker.specs.set("PROJ-OFF", "Implementation spec body.");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-OFF" });

    await runUntil(h, () => h.issueTracker.assignments.get("PROJ-OFF") === "human");

    expect(h.issueTracker.phases.get("PROJ-OFF")).toBe("spec-review");
    expect(h.issueTracker.assignments.get("PROJ-OFF")).toBe("human");
  });

  it("fails gracefully when skill file is missing", async () => {
    rmSync(join(skillsDir, "coder"), { recursive: true, force: true });
    const h = setupHarness(() => {
      throw new Error("worker should not run — skill missing");
    });
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec body.");
    const task = h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "failed");

    const stored = h.queue.getTask(task.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.result).toContain("Skill not found");
  });

  it.each([false, true])("threads Codex settings with workspaceMode=%s", async (workspaceMode) => {
    const phases = DEFAULT_PHASES.map((p) =>
      p.name === "coding" ? { ...p, agent: "codex" as const, effort: "xhigh" as const } : p,
    );
    const h = setupHarness(
      () =>
        Promise.resolve(
          makeWorkerResult({
            success: false,
            exitCode: 1,
            elapsed: 0,
            summary: "",
            error: "stop cascade",
          }),
        ),
      {
        phases,
        pipeline: { codexBin: "/bin/sh" },
        ...(workspaceMode
          ? {
              repos: makeTestConfig({ project: { directory: join(tempDir, "app") } }).project.repos,
            }
          : {}),
      },
    );
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec body.");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });

    await runUntilAfterRuns(h, 1);

    const run = h.runs[0];
    expect(run?.agent).toBe("codex");
    // The master model ("opus") must not leak across the agent override.
    expect(run?.model).toBeNull();
    expect(run?.effort).toBe("xhigh");
    expect(run?.bin).toBe("/bin/sh");
    expect(run?.cwd).toBe(tempDir);
    expect(run?.workspaceMode).toBe(workspaceMode);
    expect(run && buildWorkerArgs(run).includes("--skip-git-repo-check")).toBe(workspaceMode);
  });

  it("uses the master agent settings for phases without overrides", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 0,
          summary: "",
          error: "stop cascade",
        }),
      ),
    );
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec body.");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });

    await runUntilAfterRuns(h, 1);

    const run = h.runs[0];
    expect(run?.agent).toBe("claude-code");
    expect(run?.model).toBe("opus");
    expect(run?.effort).toBe("high");
  });

  it("fails the task when the phase's agent binary cannot be resolved", async () => {
    const phases = DEFAULT_PHASES.map((p) =>
      p.name === "coding" ? { ...p, agent: "codex" as const } : p,
    );
    const h = setupHarness(
      () => {
        throw new Error("worker should not run — codex bin missing");
      },
      { phases, pipeline: { codexBin: join(tempDir, "missing-codex") } },
    );
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec body.");
    const task = h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "failed");

    const stored = h.queue.getTask(task.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.result).toContain("codex binary not found");
  });

  it("updates priorContext from worker summary", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "handoff notes for next phase",
          error: null,
        }),
      ),
    );
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec body.");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });

    await runUntilAfterRuns(h, 1);

    const record = h.pipelineState.get("PROJ-1");
    expect(record?.priorContext).toBe("handoff notes for next phase");
  });

  it("writes successful worker warnings to the audit log", async () => {
    const escape = String.fromCodePoint(0x1b);
    const nul = String.fromCodePoint(0x00);
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
          warning: `${escape}[33mUnknown effort; using default token=secret${escape}[0m${nul}`,
        }),
      ),
    );
    h.pipelineState.create("PROJ-WARN", "coding");
    h.issueTracker.phases.set("PROJ-WARN", "coding");
    h.issueTracker.specs.set("PROJ-WARN", "Implementation spec body.");
    const task = h.queue.enqueue({ type: "coding", issueId: "PROJ-WARN" });

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "complete");

    const warnings = h.audit.query({ issueId: "PROJ-WARN", component: "worker" });
    const warning = warnings.find((entry) =>
      entry.message.includes("Unknown effort; using default"),
    );
    expect(warning?.message).toContain("token=<redacted>");
    expect(warning?.message).not.toContain("secret");
    expect(warning?.message).not.toContain(escape);
    expect(warning?.message).not.toContain(nul);
  });

  it("syncs out-of-sync phase before dispatch", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    h.pipelineState.create("PROJ-1", "coding");
    // Issue is in testing but queue has a coding task — tracker is out of sync but not at a human gate
    h.issueTracker.phases.set("PROJ-1", "testing");
    h.issueTracker.specs.set("PROJ-1", "Implementation spec body.");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });

    await runUntil(h, () => h.issueTracker.calls.some((c) => c === "setPhase:PROJ-1:coding"));

    expect(h.issueTracker.calls.some((c) => c === "setPhase:PROJ-1:coding")).toBe(true);
  });

  it("creates reconciliation task on startup", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    h.issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-99", "coding")]);
    h.issueTracker.phases.set("PROJ-99", "coding");
    h.issueTracker.specs.set("PROJ-99", "Implementation spec body.");
    h.pipelineState.create("PROJ-99", "coding");

    await runUntilAfterRuns(h, 1, 3000);

    // Task got created by reconciler and processed
    expect(h.runs.length).toBeGreaterThanOrEqual(1);
  });

  it("recovers a missed unphased assignment immediately on startup", async () => {
    const h = setupHarness(
      () =>
        Promise.resolve(
          makeWorkerResult({
            success: true,
            exitCode: 0,
            elapsed: 1,
            summary: "done",
            error: null,
          }),
        ),
      { pipeline: { reconcileInterval: 60 } },
    );
    const issue = makeIssue("PROJ-OFFLINE");
    h.issueTracker.issues.set(issue.id, issue);
    h.issueTracker.assignedToAiResults = [issue];

    await runUntilAfterRuns(h, 1, 3000);

    // The scheduled sweep is a minute away. Startup recovered the missed
    // assignment, initialized the pipeline, and dispatched the entry phase.
    expect(h.issueTracker.calls).toContain("listIssuesAssignedToAi");
    expect(h.pipelineState.get(issue.id)).not.toBeNull();
    expect(h.issueTracker.calls).toContain(`setPhase:${issue.id}:spec-writing`);
    expect(h.issueTracker.calls).not.toContain(`assignToAi:${issue.id}`);
    expect(h.runs.length).toBeGreaterThanOrEqual(1);
  });

  it("replays merged PRs before tracker reconciliation can recreate their work", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "should not run",
          error: null,
        }),
      ),
    );
    h.pipelineState.create("PROJ-99", "coding");
    h.pipelineState.updateBranchInfo("PROJ-99", "app", { prNumber: 42, prBaseBranch: "main" });
    h.sourceControl.prs.set(42, {
      number: 42,
      title: "PROJ-99",
      state: "closed",
      merged: true,
      headBranch: "feature/PROJ-99",
      baseBranch: "main",
      url: "https://example.com/pr/42",
      reviewDecision: null,
    });
    h.issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-99", "coding")]);

    await runUntil(h, () => h.pipelineState.get("PROJ-99")?.currentPhase === "done");

    expect(h.runs).toHaveLength(0);
    expect(h.queue.hasOpenTask("PROJ-99", "coding")).toBe(false);
  });

  it("continues startup when the merged-PR scan itself throws", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    h.pipelineState.listAll = () => {
      throw new Error("scan database unavailable");
    };

    await runUntil(h, () => h.orchestratorState.get().status === "idle");

    expect(
      h.audit
        .query({ component: "orchestrator" })
        .some((entry) => entry.message.includes("Startup merged-PR reconciliation failed")),
    ).toBe(true);
  });

  it("drains an in-flight merged-PR scan before shutdown completes", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    h.pipelineState.create("PROJ-99", "human-review");
    h.pipelineState.updateBranchInfo("PROJ-99", "app", { prNumber: 42, prBaseBranch: "main" });
    let resolveLookup: ((value: null) => void) | null = null;
    const lookupStarted = new Promise<void>((resolveStarted) => {
      h.sourceControl.getPullRequest = () =>
        new Promise<null>((resolvePromise) => {
          resolveLookup = resolvePromise;
          resolveStarted();
        });
    });

    const startPromise = h.rq.start();
    await lookupStarted;
    let stopped = false;
    const stopPromise = h.rq.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(stopped).toBe(false);

    resolveLookup?.(null);
    await stopPromise;
    await startPromise;
    expect(stopped).toBe(true);
  });

  it("new-ticket persists delegator from task metadata", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 0,
          summary: "",
          error: "stop cascade",
        }),
      ),
    );
    h.queue.enqueue({
      type: "new-ticket",
      issueId: "PROJ-42",
      metadata: { delegator: "justin-42" },
    });

    await runUntil(h, () => h.pipelineState.get("PROJ-42") !== null);

    const record = h.pipelineState.get("PROJ-42");
    expect(record?.delegatorAccountId).toBe("justin-42");
  });

  it("passes stored delegator to assignToHuman on phase advance", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    h.pipelineState.create("PROJ-50", "spec-writing", "justin-50");
    h.issueTracker.phases.set("PROJ-50", "spec-writing");
    h.issueTracker.specs.set("PROJ-50", "Implementation spec body.");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-50" });

    await runUntil(
      h,
      () =>
        h.issueTracker.calls.some((c) => c === "assignToHuman:PROJ-50:justin-50") ||
        h.issueTracker.assignments.get("PROJ-50") === "human",
    );

    expect(h.issueTracker.calls).toContain("assignToHuman:PROJ-50:justin-50");
  });

  it("refreshes cached spec from tracker before dispatch", async () => {
    let capturedPrompt: string | null = null;
    const h = setupHarness((opts) => {
      const promptMatch = /Read and follow (.+) exactly/.exec(opts.prompt);
      if (promptMatch?.[1] !== undefined) {
        capturedPrompt = readFileSync(promptMatch[1], "utf8");
      }
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 1,
          summary: "",
          error: "stop cascade",
        }),
      );
    });
    h.pipelineState.create("PROJ-70", "coding");
    h.pipelineState.updateSpec("PROJ-70", "STALE spec body");
    h.issueTracker.phases.set("PROJ-70", "coding");
    h.issueTracker.specs.set("PROJ-70", "FRESH spec body");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-70" });

    await runUntilAfterRuns(h, 1);

    expect(h.pipelineState.get("PROJ-70")?.specContent).toBe("FRESH spec body");
    expect(capturedPrompt).toContain("FRESH spec body");
    expect(capturedPrompt).not.toContain("STALE spec body");
  });

  it("skips spec re-fetch for spec-writing phase", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 1,
          summary: "",
          error: "stop cascade",
        }),
      ),
    );
    h.pipelineState.create("PROJ-71", "spec-writing");
    h.issueTracker.phases.set("PROJ-71", "spec-writing");
    // Tracker has a different spec value; orchestrator must not pull it during spec-writing
    h.issueTracker.specs.set("PROJ-71", "pre-existing");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-71" });

    await runUntilAfterRuns(h, 1);

    const record = h.pipelineState.get("PROJ-71");
    expect(record?.specContent).toBeNull();
  });

  it("clears stale cached spec when re-entering spec-writing", async () => {
    // Human cleared the tracker spec field and moved the ticket back to
    // spec-writing. The stale cached spec from the prior cycle must be dropped
    // on dispatch so the writer authors fresh instead of being handed last
    // cycle's prompt as context.
    let capturedPrompt: string | null = null;
    const h = setupHarness((opts) => {
      const promptMatch = /Read and follow (.+) exactly/.exec(opts.prompt);
      if (promptMatch?.[1] !== undefined) {
        capturedPrompt = readFileSync(promptMatch[1], "utf8");
      }
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 1,
          summary: "",
          error: "stop cascade",
        }),
      );
    });
    h.pipelineState.create("PROJ-REENTRY", "spec-writing");
    h.pipelineState.updateSpec("PROJ-REENTRY", "STALE prompt from last cycle");
    h.issueTracker.phases.set("PROJ-REENTRY", "spec-writing");
    // Tracker spec field is intentionally empty — the human deleted it.
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-REENTRY" });

    await runUntilAfterRuns(h, 1);

    expect(h.pipelineState.get("PROJ-REENTRY")?.specContent).toBeNull();
    expect(capturedPrompt).not.toContain("STALE prompt from last cycle");
  });

  it("does not advance to spec-review when spec-writing produces an empty spec", async () => {
    // spec-writing exits 0 but never writes a spec to the tracker. The empty-spec
    // guard treats this as a failed run (retry → onFail) rather than parking an
    // empty prompt at the spec-review human gate.
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "claims done but wrote no spec",
          error: null,
        }),
      ),
    );
    h.pipelineState.create("PROJ-EMPTY", "spec-writing");
    h.issueTracker.phases.set("PROJ-EMPTY", "spec-writing");
    // No specs.set — the tracker spec field stays empty.
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-EMPTY" });

    // maxRetries=2: one initial run plus two retries, then onFail routes the
    // ticket to spec-awaiting-info instead of spec-review.
    await runUntil(h, () => h.issueTracker.phases.get("PROJ-EMPTY") === "spec-awaiting-info");

    expect(h.issueTracker.calls).not.toContain("setPhase:PROJ-EMPTY:spec-review");
    expect(h.issueTracker.phases.get("PROJ-EMPTY")).toBe("spec-awaiting-info");
    expect(h.runs.length).toBeGreaterThanOrEqual(2);
  });

  it("posts a failure notice to the ticket when a worker failure parks it at a human gate", async () => {
    // A 401 from the Claude worker would otherwise dump the ticket at
    // spec-awaiting-info with no explanation — the reported bug. The notice gives
    // a human looking at the ticket (not the logs) the reason.
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 1,
          summary: "",
          error: 'API Error: 401 {"type":"authentication_error","message":"invalid x-api-key"}',
        }),
      ),
    );
    h.pipelineState.create("PROJ-401", "spec-writing");
    h.issueTracker.phases.set("PROJ-401", "spec-writing");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-401" });

    await runUntil(h, () => h.issueTracker.phases.get("PROJ-401") === "spec-awaiting-info");

    const comments = h.issueTracker.commentsById.get("PROJ-401") ?? [];
    // Exactly one — posted on the terminal gate landing, not on each retry.
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("authenticate");
    expect(comments[0]?.body).toContain("401");
  });

  it("does not post a failure notice when a failure bounces to an automated phase", async () => {
    // code-review -> coding is a normal feedback loop; commenting there would
    // spam the ticket every reconcile cycle, so no notice is posted.
    const h = setupHarness(() => {
      void h.rq.stop();
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 0,
          summary: "",
          error: "blockers found",
        }),
      );
    });
    h.pipelineState.create("PROJ-NC", "code-review");
    h.issueTracker.phases.set("PROJ-NC", "code-review");
    h.issueTracker.specs.set("PROJ-NC", "Implementation spec body.");
    h.queue.enqueue({ type: "code-review", issueId: "PROJ-NC" });

    await runUntil(h, () => h.pipelineState.get("PROJ-NC")?.currentPhase === "coding");

    expect(h.issueTracker.commentsById.get("PROJ-NC") ?? []).toHaveLength(0);
  });

  it("overrides a self-advance to spec-review when the worker wrote no spec", async () => {
    // Skills are LLM-driven: the prompt-writer is told to self-route only to the
    // escape phases, but if it instead pushes the tracker forward to spec-review
    // while writing no spec, that's the empty-spec failure wearing a phase-change
    // disguise. The retry path can't recover it (a re-dispatch is stale once the
    // tracker sits on a gate), so the guard routes straight to onFail and assigns
    // the human there rather than parking an empty prompt at spec-review.
    const h = setupHarness(() => {
      void h.issueTracker.setPhase("PROJ-SELF", "spec-review");
      return Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "self-routed to review but wrote no spec",
          error: null,
        }),
      );
    });
    h.pipelineState.create("PROJ-SELF", "spec-writing");
    h.issueTracker.phases.set("PROJ-SELF", "spec-writing");
    // No specs.set — the tracker spec field stays empty.
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-SELF" });

    await runUntil(h, () => h.issueTracker.phases.get("PROJ-SELF") === "spec-awaiting-info");

    expect(h.issueTracker.phases.get("PROJ-SELF")).toBe("spec-awaiting-info");
    // Human is assigned at the escape gate — not left silently parked at the
    // review gate the worker jumped to.
    expect(h.issueTracker.calls).toContain("assignToHuman:PROJ-SELF:none");
    // skipRetry: escalated on the single run rather than enqueuing a doomed retry.
    expect(h.runs.length).toBe(1);
  });

  it("posts a failure-notice comment when a worker exhausts retries into a human-gate", async () => {
    // A stalled/crashed worker produces no output and is routed to spec-awaiting-info
    // via onFail — the same gate the prompt-writer uses to deliberately ask the
    // reporter for clarification, but with no question attached. Without a comment the
    // human can't tell an infra failure from a real clarification request. The notice
    // names the failed phase and surfaces the worker error.
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: -1,
          elapsed: 1,
          summary: "",
          error: "Worker stalled (no CPU work for 300s)",
        }),
      ),
    );
    h.pipelineState.create("PROJ-STALL", "spec-writing");
    h.issueTracker.phases.set("PROJ-STALL", "spec-writing");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-STALL" });

    await runUntil(h, () => h.issueTracker.phases.get("PROJ-STALL") === "spec-awaiting-info");

    const comments = h.issueTracker.commentsById.get("PROJ-STALL") ?? [];
    expect(comments.length).toBe(1);
    expect(comments[0]?.body).toContain("Worker stalled (no CPU work for 300s)");
    expect(comments[0]?.body).toContain("Spec Writing");
  });

  it("auto-transitions human-review -> code-feedback when PR exists", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 1,
          summary: "",
          error: "stop cascade",
        }),
      ),
    );
    h.pipelineState.create("PROJ-80", "human-review");
    h.pipelineState.updatePrNumber("PROJ-80", "app", 42, null);
    h.issueTracker.phases.set("PROJ-80", "human-review");
    h.queue.enqueue({ type: "code-feedback", issueId: "PROJ-80" });

    await runUntilAfterRuns(h, 1);

    const transitionIdx = h.issueTracker.calls.indexOf("setPhase:PROJ-80:code-feedback");
    expect(transitionIdx).toBeGreaterThanOrEqual(0);
    expect(h.issueTracker.calls.indexOf("assignToAi:PROJ-80")).toBeGreaterThan(transitionIdx);
    expect(h.runs.length).toBeGreaterThanOrEqual(1);
  });

  it("auto-transitions spec-review -> spec-feedback when no PR exists", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 1,
          summary: "",
          error: "stop cascade",
        }),
      ),
    );
    h.pipelineState.create("PROJ-81", "spec-review");
    h.issueTracker.phases.set("PROJ-81", "spec-review");
    h.queue.enqueue({ type: "spec-feedback", issueId: "PROJ-81" });

    await runUntilAfterRuns(h, 1);

    const transitionIdx = h.issueTracker.calls.indexOf("setPhase:PROJ-81:spec-feedback");
    expect(transitionIdx).toBeGreaterThanOrEqual(0);
    expect(h.issueTracker.calls.indexOf("assignToAi:PROJ-81")).toBeGreaterThan(transitionIdx);
    expect(h.runs.length).toBeGreaterThanOrEqual(1);
  });

  it("does not auto-transition when task type is not the gate rework", async () => {
    const h = setupHarness(() => {
      throw new Error("worker should not run — task must be marked stale");
    });
    h.pipelineState.create("PROJ-82", "human-review");
    h.pipelineState.updatePrNumber("PROJ-82", "app", 50, null);
    h.issueTracker.phases.set("PROJ-82", "human-review");
    const task = h.queue.enqueue({ type: "coding", issueId: "PROJ-82" });

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "complete");

    expect(h.issueTracker.phases.get("PROJ-82")).toBe("human-review");
    const stored = h.queue.getTask(task.id);
    expect(stored?.result).toContain("Stale");
  });

  it("does not auto-transition code-feedback without a PR", async () => {
    const h = setupHarness(() => {
      throw new Error("worker should not run — task must be marked stale");
    });
    h.pipelineState.create("PROJ-83", "human-review");
    h.issueTracker.phases.set("PROJ-83", "human-review");
    const task = h.queue.enqueue({ type: "code-feedback", issueId: "PROJ-83" });

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "complete");

    expect(h.issueTracker.phases.get("PROJ-83")).toBe("human-review");
    const stored = h.queue.getTask(task.id);
    expect(stored?.result).toContain("Stale");
  });

  it("keeps cached spec and logs when getSpec throws", async () => {
    const auditPathLocal = auditPath;
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 1,
          summary: "",
          error: "stop cascade",
        }),
      ),
    );
    // PROJ-90 is in coding (next-after-spec-review), so syncSpecFromTracker runs.
    h.pipelineState.create("PROJ-90", "coding");
    h.pipelineState.updateSpec("PROJ-90", "CACHED spec");
    h.issueTracker.phases.set("PROJ-90", "coding");
    h.issueTracker.getSpecThrowsFor.add("PROJ-90");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-90" });

    await runUntilAfterRuns(h, 1);

    // Cache preserved
    expect(h.pipelineState.get("PROJ-90")?.specContent).toBe("CACHED spec");
    // Audit logged the failure
    const audit = readFileSync(auditPathLocal, "utf8");
    expect(audit).toContain("Pre-dispatch spec re-read failed");
  });

  it("keeps cached spec and warns when tracker returns null but cache has content", async () => {
    const auditPathLocal = auditPath;
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 1,
          summary: "",
          error: "stop cascade",
        }),
      ),
    );
    h.pipelineState.create("PROJ-91", "coding");
    h.pipelineState.updateSpec("PROJ-91", "CACHED spec");
    h.issueTracker.phases.set("PROJ-91", "coding");
    // Tracker has no spec stored — getSpec returns null
    h.queue.enqueue({ type: "coding", issueId: "PROJ-91" });

    await runUntilAfterRuns(h, 1);

    // Cache preserved despite null from tracker
    expect(h.pipelineState.get("PROJ-91")?.specContent).toBe("CACHED spec");
    const audit = readFileSync(auditPathLocal, "utf8");
    expect(audit).toContain("Tracker returned no spec but a cached spec exists");
  });

  it("updates pipelineState.currentPhase after successful auto-transition", async () => {
    let phaseAtDispatch: string | null | undefined;
    const h = setupHarness(() => {
      // Capture the pipelineState record at the moment the worker runs — this
      // is right after tryAutoTransitionRework has committed the transition
      // and before handleFailure's retry/escalate cascade can mutate it.
      phaseAtDispatch = h.pipelineState.get("PROJ-92")?.currentPhase;
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 1,
          summary: "",
          error: "stop cascade",
        }),
      );
    });
    h.pipelineState.create("PROJ-92", "human-review");
    h.pipelineState.updatePrNumber("PROJ-92", "app", 42, null);
    h.issueTracker.phases.set("PROJ-92", "human-review");
    h.queue.enqueue({ type: "code-feedback", issueId: "PROJ-92" });

    await runUntilAfterRuns(h, 1);

    expect(phaseAtDispatch).toBe("code-feedback");
  });

  it("calls dismissStaleReviews after a requiresPr phase succeeds", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "addressed feedback",
          error: null,
        }),
      ),
    );
    h.pipelineState.create("PROJ-100", "code-feedback");
    h.pipelineState.updatePrNumber("PROJ-100", "app", 77, null);
    h.issueTracker.phases.set("PROJ-100", "code-feedback");
    h.queue.enqueue({ type: "code-feedback", issueId: "PROJ-100" });

    await runUntil(h, () => h.sourceControl.calls.includes("dismissStaleReviews:77"));

    expect(h.sourceControl.calls).toContain("dismissStaleReviews:77");
  });

  it("dismisses reviews through each in-scope repo adapter and continues after an adapter fails", async () => {
    const app = new MockSourceControl();
    const web = new MockSourceControl();
    const docs = new MockSourceControl();
    const pending = new MockSourceControl();
    app.dismissStaleReviewsThrows = true;
    const repos = ["app", "web", "docs", "pending"].map((name) => ({
      name,
      path: join(tempDir, name),
      owner: "acme",
      repo: name,
      baseBranch: "origin/main",
      buildCommand: "build",
      testCommand: "test",
      modules: [],
    }));
    const h = setupHarness(
      () =>
        Promise.resolve(
          makeWorkerResult({
            success: true,
            exitCode: 0,
            elapsed: 1,
            summary: "done",
            error: null,
          }),
        ),
      {
        repos,
        extra: {
          sourceControls: createSourceControlRegistry([
            { name: "app", fullName: "acme/app", adapter: app },
            { name: "web", fullName: "acme/web", adapter: web },
            { name: "docs", fullName: "acme/docs", adapter: docs },
            { name: "pending", fullName: "acme/pending", adapter: pending },
          ]),
        },
      },
    );
    h.pipelineState.create("PROJ-MULTI", "code-feedback");
    h.pipelineState.setScope("PROJ-MULTI", ["app", "web", "docs"]);
    for (const name of ["app", "web", "docs"]) {
      h.pipelineState.updatePrNumber("PROJ-MULTI", name, 77, null);
    }
    h.pipelineState.setScope("PROJ-MULTI", ["app", "web", "pending"]);
    h.issueTracker.phases.set("PROJ-MULTI", "code-feedback");
    h.queue.enqueue({ type: "code-feedback", issueId: "PROJ-MULTI" });

    await runUntil(h, () => web.calls.includes("dismissStaleReviews:77"));

    expect(app.calls).toContain("dismissStaleReviews:77");
    expect(web.calls).toContain("dismissStaleReviews:77");
    expect(docs.calls.some((call) => call.startsWith("dismissStaleReviews"))).toBe(false);
    expect(pending.calls.some((call) => call.startsWith("dismissStaleReviews"))).toBe(false);
    expect(
      h.audit
        .query({ issueId: "PROJ-MULTI" })
        .find((entry) => entry.message.startsWith("dismissStaleReviews failed"))?.metadata,
    ).toMatchObject({ repo: "app", prNumber: 77 });
  });

  it("adopts modern legacy-mode spec-only rows before startup reconciliation", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({ success: true, exitCode: 0, elapsed: 1, summary: "done", error: null }),
      ),
    );
    h.pipelineState.create("PROJ-LEGACY", "spec-review");
    h.db.db
      .prepare("UPDATE pipeline_state SET spec_content = ? WHERE issue_id = ?")
      .run("legacy spec", "PROJ-LEGACY");
    h.issueTracker.phases.set("PROJ-LEGACY", "spec-review");
    expect(h.pipelineState.get("PROJ-LEGACY")?.repos).toEqual([]);

    await runUntil(h, () => (h.pipelineState.get("PROJ-LEGACY")?.repos.length ?? 0) > 0);

    expect(h.pipelineState.get("PROJ-LEGACY")?.repos).toEqual([
      expect.objectContaining({ repo: "app", inScope: true }),
    ]);
    expect(readFileSync(auditPath, "utf8")).toContain(
      "Adopted 1 legacy pipeline record(s) into repo app",
    );
  });

  it("startup adopts old legacy rows without assigning scope to a modern one-repo workspace", async () => {
    const repos = makeTestConfig({ project: { directory: tempDir } }).project.repos;
    const h = setupHarness(
      () =>
        Promise.resolve(
          makeWorkerResult({
            success: true,
            exitCode: 0,
            elapsed: 1,
            summary: "done",
            error: null,
          }),
        ),
      { repos },
    );
    h.pipelineState.create("PROJ-NEW", "spec-review");
    h.pipelineState.updateSpec("PROJ-NEW", "new workspace spec before scope selection");
    h.db.db
      .prepare(
        `INSERT INTO pipeline_state (issue_id, current_phase, spec_content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`,
      )
      .run("PROJ-OLD", "spec-review", "old legacy spec", "2026-01-01", "2026-01-01");
    h.issueTracker.phases.set("PROJ-NEW", "spec-review");
    h.issueTracker.phases.set("PROJ-OLD", "spec-review");

    await runUntil(h, () => (h.pipelineState.get("PROJ-OLD")?.repos.length ?? 0) > 0);

    expect(h.pipelineState.getRepo("PROJ-OLD", "app")?.inScope).toBe(true);
    expect(h.pipelineState.get("PROJ-NEW")?.repos).toEqual([]);
  });

  it("startup re-keys legacy rows stored under a previous repo name", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({ success: true, exitCode: 0, elapsed: 1, summary: "done", error: null }),
      ),
    );
    h.pipelineState.create("PROJ-RENAMED", "spec-review");
    h.pipelineState.updateBranchInfo("PROJ-RENAMED", "old-app", {
      branchName: "feature/PROJ-RENAMED",
      prNumber: 12,
    });
    h.issueTracker.phases.set("PROJ-RENAMED", "spec-review");

    await runUntil(h, () => h.pipelineState.getRepo("PROJ-RENAMED", "app") !== null);

    expect(h.pipelineState.get("PROJ-RENAMED")?.repos).toEqual([
      expect.objectContaining({ repo: "app", branchName: "feature/PROJ-RENAMED", prNumber: 12 }),
    ]);
    expect(readFileSync(auditPath, "utf8")).toContain("Re-keyed 1 pipeline record(s) to repo app");
  });

  it("refuses to start a workspace whose unfinished issues name an unconfigured repo", async () => {
    const repos = makeTestConfig({ project: { directory: tempDir } }).project.repos;
    const h = setupHarness(
      () =>
        Promise.resolve(
          makeWorkerResult({
            success: true,
            exitCode: 0,
            elapsed: 1,
            summary: "done",
            error: null,
          }),
        ),
      { repos },
    );
    h.pipelineState.create("PROJ-GONE", "coding");
    h.pipelineState.updateBranch("PROJ-GONE", "removed", "feature/PROJ-GONE");

    await expect(h.rq.start()).rejects.toThrow(/PROJ-GONE → removed/);
    expect(h.orchestratorState.get().status).toBe("stopped");
  });

  it("skips dismissStaleReviews when phase does not require PR", async () => {
    // coding succeeds but does not have requiresPr: true
    let runCount = 0;
    const h = setupHarness(() => {
      runCount++;
      if (runCount === 1) {
        return Promise.resolve(
          makeWorkerResult({
            success: true,
            exitCode: 0,
            elapsed: 1,
            summary: "done",
            error: null,
          }),
        );
      }
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 0,
          summary: "",
          error: "stop cascade",
        }),
      );
    });
    h.pipelineState.create("PROJ-101", "coding");
    h.pipelineState.updatePrNumber("PROJ-101", "app", 78, null);
    h.issueTracker.phases.set("PROJ-101", "coding");
    h.issueTracker.specs.set("PROJ-101", "Implementation spec body.");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-101" });

    await runUntilAfterRuns(h, 1);

    expect(h.sourceControl.calls.some((c) => c.startsWith("dismissStaleReviews"))).toBe(false);
  });

  it("skips dismissStaleReviews when prNumber is null", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    // code-feedback with no PR — orchestrator auto-transition guard should have prevented dispatch,
    // but if we bypass by seeding the phase directly, dismissStaleReviews must still be skipped.
    h.pipelineState.create("PROJ-102", "code-feedback");
    // intentionally no updatePrNumber
    h.issueTracker.phases.set("PROJ-102", "code-feedback");
    h.queue.enqueue({ type: "code-feedback", issueId: "PROJ-102" });

    await runUntilAfterRuns(h, 1);

    expect(h.sourceControl.calls.some((c) => c.startsWith("dismissStaleReviews"))).toBe(false);
  });

  it("continues pipeline when dismissStaleReviews throws", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "addressed",
          error: null,
        }),
      ),
    );
    h.sourceControl.dismissStaleReviewsThrows = true;
    h.pipelineState.create("PROJ-103", "code-feedback");
    h.pipelineState.updatePrNumber("PROJ-103", "app", 99, null);
    h.issueTracker.phases.set("PROJ-103", "code-feedback");
    const task = h.queue.enqueue({ type: "code-feedback", issueId: "PROJ-103" });

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "complete");

    // Task still marked complete — dismiss failure must not fail the task
    expect(h.queue.getTask(task.id)?.status).toBe("complete");
    // Audit should record the failure
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain("dismissStaleReviews failed");
  });

  it("transitionTo on failure passes stored delegator to assignToHuman", async () => {
    // Pre-bump reviewIterations past maxIterations so code-review failure escalates
    // immediately via transitionTo, which is the path that reads delegator.
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 1,
          summary: "",
          error: "rejected",
        }),
      ),
    );
    h.pipelineState.create("PROJ-60", "code-review", "justin-60");
    h.issueTracker.phases.set("PROJ-60", "code-review");
    for (let i = 0; i < 10; i++) {
      h.pipelineState.incrementReviewIterations("PROJ-60");
      h.pipelineState.incrementPhaseReworks("PROJ-60", "code-review");
    }
    h.queue.enqueue({ type: "code-review", issueId: "PROJ-60" });

    await runUntil(
      h,
      () => h.issueTracker.calls.some((c) => c.startsWith("assignToHuman:PROJ-60:")),
      { maxMs: 5000 },
    );

    expect(h.issueTracker.calls.some((c) => c === "assignToHuman:PROJ-60:justin-60")).toBe(true);
  });

  it("Gap 1: calls markInProgress once on happy-path dispatch", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    h.pipelineState.create("PROJ-201", "coding");
    h.issueTracker.phases.set("PROJ-201", "coding");
    h.issueTracker.specs.set("PROJ-201", "Implementation spec body.");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-201" });

    await runUntilAfterRuns(h, 1);

    expect(h.issueTracker.calls).toContain("markInProgress:PROJ-201");
  });

  it("Gap 1: swallows markInProgress failures, worker still dispatches", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    h.pipelineState.create("PROJ-202", "coding");
    h.issueTracker.phases.set("PROJ-202", "coding");
    h.issueTracker.specs.set("PROJ-202", "Implementation spec body.");
    h.issueTracker.markInProgressThrowsFor.add("PROJ-202");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-202" });

    await runUntilAfterRuns(h, 1);

    // Worker dispatched despite markInProgress throwing
    expect(h.runs.length).toBeGreaterThanOrEqual(1);
    // Audit should mention the non-fatal failure
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain("markInProgress failed (non-fatal)");
  });

  it("Gap 1: does not call markInProgress on fail-fast dispatch paths", async () => {
    // Skill not found → fail-fast before reaching the markInProgress call site.
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    // Remove the reviewer skill file to force "Skill not found"
    rmSync(join(skillsDir, "reviewer"), { recursive: true, force: true });
    h.pipelineState.create("PROJ-203", "code-review");
    h.issueTracker.phases.set("PROJ-203", "code-review");
    h.queue.enqueue({ type: "code-review", issueId: "PROJ-203" });

    await runUntil(h, () => h.queue.listByStatus("failed").some((t) => t.issueId === "PROJ-203"));

    expect(h.issueTracker.calls).not.toContain("markInProgress:PROJ-203");
  });

  it("Gap 3: resets iteration counters when leaving a human-gate phase", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    h.pipelineState.create("PROJ-301", "human-review");
    h.pipelineState.incrementReviewIterations("PROJ-301");
    h.pipelineState.incrementReviewIterations("PROJ-301");
    h.pipelineState.incrementFeedbackIterations("PROJ-301");
    h.issueTracker.phases.set("PROJ-301", "code-feedback");
    h.queue.enqueue({ type: "code-feedback", issueId: "PROJ-301" });

    await runUntilAfterRuns(h, 1);

    const record = h.pipelineState.get("PROJ-301");
    expect(record?.reviewIterations).toBe(0);
    expect(record?.feedbackIterations).toBe(0);
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain("Leaving human gate human-review");
  });

  it("Gap 3: does not reset when leaving an automated phase", async () => {
    // Use code-review → testing pairing (both automated) with a passing
    // worker on testing. Gate-leave reset must not fire (prior phase is
    // automated) and the Alice-parity code-review-pass reset isn't in scope
    // either (the worker isn't running code-review here).
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        }),
      ),
    );
    h.pipelineState.create("PROJ-302", "code-review");
    h.pipelineState.incrementReviewIterations("PROJ-302");
    h.pipelineState.incrementReviewIterations("PROJ-302");
    h.issueTracker.phases.set("PROJ-302", "testing");
    h.queue.enqueue({ type: "testing", issueId: "PROJ-302" });

    await runUntilAfterRuns(h, 1);

    const record = h.pipelineState.get("PROJ-302");
    expect(record?.reviewIterations).toBe(2);
  });

  it("Alice parity: coding pass does NOT reset reviewIterations on entry to code-review", async () => {
    // Only resetReviewIterationsOnPass=true on a SUCCESSFUL run should clear
    // the counter. Entering code-review from a coding pass must preserve the
    // count so the next review attempt is the (N+1)th.
    //
    // Strategy: coding succeeds → enters code-review with reviewIterations=3;
    // code-review then exhausts its retry budget and fails → handleFailure
    // increments to 4 → 4 > maxIterations=3 → escalates to human-review.
    // If entry-to-code-review had reset to 0, the failure increment would
    // land at 1, escalation wouldn't fire, and the pipeline would fall back
    // to coding (which has no onFail) and stall.
    let runCount = 0;
    const h = setupHarness(() => {
      runCount += 1;
      if (runCount === 1) {
        return Promise.resolve(
          makeWorkerResult({
            success: true,
            exitCode: 0,
            elapsed: 1,
            summary: "code written",
            error: null,
          }),
        );
      }
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 1,
          summary: "review failed",
          error: "blockers found",
        }),
      );
    });
    h.pipelineState.create("PROJ-304", "coding");
    h.pipelineState.incrementReviewIterations("PROJ-304");
    h.pipelineState.incrementPhaseReworks("PROJ-304", "code-review");
    h.pipelineState.incrementReviewIterations("PROJ-304");
    h.pipelineState.incrementPhaseReworks("PROJ-304", "code-review");
    h.pipelineState.incrementReviewIterations("PROJ-304");
    h.pipelineState.incrementPhaseReworks("PROJ-304", "code-review");
    h.issueTracker.phases.set("PROJ-304", "coding");
    h.issueTracker.specs.set("PROJ-304", "Implementation spec body.");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-304" });

    await runUntil(h, () => h.pipelineState.get("PROJ-304")?.currentPhase === "human-review", {
      maxMs: 5000,
    });

    const record = h.pipelineState.get("PROJ-304");
    expect(record?.currentPhase).toBe("human-review");
    expect(record?.reviewIterations).toBe(4);
  });

  it("Alice parity: code-review pass resets reviewIterations but not feedbackIterations", async () => {
    const h = setupHarness(() =>
      Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "approved",
          error: null,
        }),
      ),
    );
    h.pipelineState.create("PROJ-303", "code-review");
    h.pipelineState.incrementReviewIterations("PROJ-303");
    h.pipelineState.incrementReviewIterations("PROJ-303");
    h.pipelineState.incrementFeedbackIterations("PROJ-303");
    h.pipelineState.incrementFeedbackIterations("PROJ-303");
    h.issueTracker.phases.set("PROJ-303", "code-review");
    h.queue.enqueue({ type: "code-review", issueId: "PROJ-303" });

    await runUntilAfterRuns(h, 1);

    const record = h.pipelineState.get("PROJ-303");
    expect(record?.reviewIterations).toBe(0);
    // feedback_iterations is for spec rework — unrelated to code-review pass.
    expect(record?.feedbackIterations).toBe(2);
  });

  it("Gap 4: respectAgentPhaseChange to human-gate calls assignToHuman", async () => {
    const h = setupHarness(() => {
      // Simulate the prompt-writer self-routing to spec-awaiting-info
      void h.issueTracker.setPhase("PROJ-401", "spec-awaiting-info");
      return Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "awaiting info",
          error: null,
        }),
      );
    });
    h.pipelineState.create("PROJ-401", "spec-writing", "reporter-42");
    h.issueTracker.phases.set("PROJ-401", "spec-writing");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-401" });

    await runUntil(h, () =>
      h.issueTracker.calls.some((c) => c.startsWith("assignToHuman:PROJ-401:")),
    );

    expect(h.issueTracker.calls).toContain("assignToHuman:PROJ-401:reporter-42");
    expect(h.pipelineState.get("PROJ-401")?.currentPhase).toBe("spec-awaiting-info");
  });

  it("Gap 4: respectAgentPhaseChange to blocked calls assignToHuman (regression)", async () => {
    const h = setupHarness(() => {
      void h.issueTracker.setPhase("PROJ-402", "blocked");
      return Promise.resolve(
        makeWorkerResult({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "blocked",
          error: null,
        }),
      );
    });
    h.pipelineState.create("PROJ-402", "coding", "reporter-99");
    h.issueTracker.phases.set("PROJ-402", "coding");
    h.issueTracker.specs.set("PROJ-402", "Implementation spec body.");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-402" });

    await runUntil(h, () =>
      h.issueTracker.calls.some((c) => c.startsWith("assignToHuman:PROJ-402:")),
    );

    expect(h.issueTracker.calls).toContain("assignToHuman:PROJ-402:reporter-99");
  });

  it("kicks coding back to spec-writing when no spec exists, without launching the coder", async () => {
    const prompts: string[] = [];
    const h = setupHarness((opts) => {
      const content = readDispatchedPrompt(opts);
      if (content !== null) {
        prompts.push(content);
      }
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 0,
          summary: "",
          error: "stop cascade",
          usage: null,
        }),
      );
    });
    // The bug: a ticket moved straight to coding with no spec in cache or tracker.
    h.pipelineState.create("PROJ-NOSPEC", "coding");
    h.issueTracker.phases.set("PROJ-NOSPEC", "coding");
    const codingTask = h.queue.enqueue({ type: "coding", issueId: "PROJ-NOSPEC" });

    await runUntil(h, () => h.queue.getTask(codingTask.id)?.status === "complete");

    const stored = h.queue.getTask(codingTask.id);
    expect(stored?.status).toBe("complete");
    expect(stored?.result).toContain("kicked");
    // The coder never ran for this ticket — only the kicked-back spec-writing did.
    expect(prompts.some((c) => c.includes("phaseName: coding"))).toBe(false);
    expect(h.issueTracker.calls).toContain("setPhase:PROJ-NOSPEC:spec-writing");
  });

  it("aborts an in-flight worker when the ticket is moved out of its phase", async () => {
    let runCount = 0;
    const h = setupHarness(
      (opts) => {
        runCount += 1;
        if (runCount === 1) {
          // Coder is running; simulate a human moving the ticket off coding.
          h.issueTracker.phases.set("PROJ-ABORT", "spec-writing");
          return new Promise<WorkerResult>((resolve) => {
            opts.signal?.addEventListener(
              "abort",
              () => {
                resolve(
                  makeWorkerResult({
                    success: false,
                    exitCode: -1,
                    elapsed: 1,
                    summary: "",
                    error: "Aborted — ticket left the phase",
                    usage: null,
                  }),
                );
              },
              { once: true },
            );
          });
        }
        // The follow-up spec-writing run fails fast so nothing hangs.
        return Promise.resolve(
          makeWorkerResult({
            success: false,
            exitCode: 1,
            elapsed: 0,
            summary: "",
            error: "stop cascade",
            usage: null,
          }),
        );
      },
      // Tiny grace so a persistent (human-move) drift aborts within the test window.
      { extra: { phaseWatchIntervalMs: 5, phaseDriftGraceMs: 1 } },
    );
    h.pipelineState.create("PROJ-ABORT", "coding");
    h.pipelineState.updateSpec("PROJ-ABORT", "real spec");
    h.issueTracker.phases.set("PROJ-ABORT", "coding");
    h.issueTracker.specs.set("PROJ-ABORT", "real spec");
    const codingTask = h.queue.enqueue({ type: "coding", issueId: "PROJ-ABORT" });

    await runUntil(h, () => h.queue.getTask(codingTask.id)?.status === "complete");

    const stored = h.queue.getTask(codingTask.id);
    // Aborted — marked complete, not failed/retried.
    expect(stored?.status).toBe("complete");
    expect(stored?.result).toContain("Aborted");
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain("aborting worker");
  });

  it("does not abort when the ticket advances to the phase's own next", async () => {
    let runCount = 0;
    const h = setupHarness(
      () => {
        runCount += 1;
        if (runCount === 1) {
          // Coder self-advances to code-review (coding.next) and keeps running
          // briefly so the watch ticks while the tracker sits on next.
          h.issueTracker.phases.set("PROJ-NEXT", "code-review");
          return new Promise<WorkerResult>((resolve) => {
            setTimeout(() => {
              resolve(
                makeWorkerResult({
                  success: true,
                  exitCode: 0,
                  elapsed: 1,
                  summary: "coded",
                  error: null,
                  usage: null,
                }),
              );
            }, 40);
          });
        }
        // Downstream phases succeed fast; advanceNormal drives the tracker phase
        // forward so no spurious drift is detected.
        return Promise.resolve(
          makeWorkerResult({
            success: true,
            exitCode: 0,
            elapsed: 1,
            summary: "ok",
            error: null,
            usage: null,
          }),
        );
      },
      { extra: { phaseWatchIntervalMs: 5 } },
    );
    h.pipelineState.create("PROJ-NEXT", "coding");
    h.pipelineState.updateSpec("PROJ-NEXT", "real spec");
    h.issueTracker.phases.set("PROJ-NEXT", "coding");
    h.issueTracker.specs.set("PROJ-NEXT", "real spec");
    const codingTask = h.queue.enqueue({ type: "coding", issueId: "PROJ-NEXT" });

    await runUntil(h, () => h.queue.getTask(codingTask.id)?.status === "complete");

    const stored = h.queue.getTask(codingTask.id);
    expect(stored?.status).toBe("complete");
    // Completed via the normal success path — the watch did not abort on next.
    expect(stored?.result).not.toContain("Aborted");
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).not.toContain("aborting worker");
  });

  it("does not abort a self-route to an escape phase that finishes within the grace", async () => {
    let runCount = 0;
    const h = setupHarness(
      () => {
        runCount += 1;
        if (runCount === 1) {
          // Coder self-routes to `blocked` (an escape phase, not coding.next) as its
          // final act, then keeps running briefly while it "emits its summary" — the
          // wrap-up window the watch must not kill. The long grace outlasts the worker,
          // so it lands on the success path and its real summary survives.
          h.issueTracker.phases.set("PROJ-SELF", "blocked");
          return new Promise<WorkerResult>((resolve) => {
            setTimeout(() => {
              resolve(
                makeWorkerResult({
                  success: true,
                  exitCode: 0,
                  elapsed: 1,
                  summary: "Blocked — needs human input",
                  error: null,
                  usage: null,
                }),
              );
            }, 30);
          });
        }
        return Promise.resolve(
          makeWorkerResult({
            success: true,
            exitCode: 0,
            elapsed: 1,
            summary: "ok",
            error: null,
            usage: null,
          }),
        );
      },
      { extra: { phaseWatchIntervalMs: 5, phaseDriftGraceMs: 10_000 } },
    );
    h.pipelineState.create("PROJ-SELF", "coding");
    h.pipelineState.updateSpec("PROJ-SELF", "real spec");
    h.issueTracker.phases.set("PROJ-SELF", "coding");
    h.issueTracker.specs.set("PROJ-SELF", "real spec");
    const codingTask = h.queue.enqueue({ type: "coding", issueId: "PROJ-SELF" });

    await runUntil(h, () => h.queue.getTask(codingTask.id)?.status === "complete");

    const stored = h.queue.getTask(codingTask.id);
    expect(stored?.status).toBe("complete");
    // Not aborted: the worker's real summary survives, not the generic "Aborted …".
    expect(stored?.result).toBe("Blocked — needs human input");
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).not.toContain("aborting worker");
  });

  it("self-heals the temp dir if it is reaped mid-life (tmp-cleaner regression)", async () => {
    // Repro for the production outage: the daemon's prompt-file temp dir was
    // created once at startup and reaped by systemd-tmpfiles after ~10 days, so
    // every later dispatch ENOENT'd on writeFileSync and no worker ever ran.
    const tmpRoot = join(tempDir, ".redqueen", "tmp");
    let runCount = 0;
    const prompts: (string | null)[] = [];
    const h = setupHarness((opts) => {
      runCount += 1;
      prompts.push(readDispatchedPrompt(opts));
      if (runCount === 1) {
        // Delete the temp dir out from under the running daemon.
        rmSync(tmpRoot, { recursive: true, force: true });
      }
      return Promise.resolve(
        makeWorkerResult({
          success: false,
          exitCode: 1,
          elapsed: 0,
          summary: "",
          error: "stop cascade",
          usage: null,
        }),
      );
    });
    h.pipelineState.create("PROJ-REAP", "coding");
    h.issueTracker.phases.set("PROJ-REAP", "coding");
    h.issueTracker.specs.set("PROJ-REAP", "Implementation spec body.");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-REAP" });

    // The retry dispatches after the reap. Without the per-write self-heal its
    // writeFileSync ENOENTs and the worker never runs again, so runCount stays 1.
    await runUntilAfterRuns(h, 2, 3000);

    expect(runCount).toBeGreaterThanOrEqual(2);
    expect(prompts[1]).not.toBeNull();
    expect(prompts[1]).toContain("phaseName: coding");
  });

  it("prunes the audit log on startup and respects the interval gate", async () => {
    let nowMs = 1_700_000_000_000;
    const spy = new SpyAudit();
    const h = setupHarness(
      () =>
        Promise.resolve(
          makeWorkerResult({
            success: true,
            exitCode: 0,
            elapsed: 1,
            summary: "done",
            error: null,
          }),
        ),
      { extra: { audit: spy, now: () => nowMs } },
    );

    const waitFor = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && predicate() === false) {
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    const startPromise = h.rq.start();
    try {
      // Startup prune fires on the first tick, with the configured retention.
      await waitFor(() => spy.pruneCalls.length >= 1);
      expect(spy.pruneCalls).toEqual([30]);

      // Within the interval, no second prune however many ticks run.
      nowMs += 60 * 60 * 1000; // +1h, well under the 24h interval
      await new Promise((r) => setTimeout(r, 50));
      expect(spy.pruneCalls).toEqual([30]);

      // Past the interval, it prunes again.
      nowMs += 24 * 60 * 60 * 1000;
      await waitFor(() => spy.pruneCalls.length >= 2);
      expect(spy.pruneCalls).toEqual([30, 30]);
    } finally {
      await h.rq.stop();
      await startPromise.catch(() => {
        // Shutdown clears the main loop
      });
    }
  });
});

class SpyAudit implements AuditLogger {
  pruneCalls: number[] = [];
  log(): void {
    // no-op: this spy only cares about prune()
  }
  query(): AuditEntry[] {
    return [];
  }
  prune(days: number): number {
    this.pruneCalls.push(days);
    return 0;
  }
}
