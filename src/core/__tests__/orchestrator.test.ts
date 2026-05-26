import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { RedQueenDeps } from "../orchestrator.js";
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
}

function setupHarness(
  workerImpl: (opts: WorkerOptions) => Promise<WorkerResult>,
  options: HarnessOptions = {},
): Harness {
  const db = new RedQueenDatabase(dbPath);
  const queue = new SqliteTaskQueue(db.db);
  const pipelineState = new PipelineStateStore(db.db);
  const phaseUsage = new PhaseUsageStore(db.db);
  const orchestratorState = new OrchestratorStateStore(db.db);
  const audit = new DualWriteAuditLogger(db.db, auditPath);
  const issueTracker = new MockIssueTracker();
  const sourceControl = new MockSourceControl();
  const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
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
      baseBranch: "origin/main",
      branchPrefixes: { default: "feature/" },
      webhooks: { enabled: false },
      cost: { enabled: false, pricing: {} },
      model: "opus",
      effort: "high",
      stallThresholdMs: 60_000,
      reconcileInterval: 0,
      claudeBin: "/bin/sh",
      skipSpecReviewIfReady: options.skipSpecReviewIfReady ?? false,
    },
  });
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
    sourceControl,
    workerRunner: wrappedWorker,
    installSignalHandlers: false,
    sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    ...(options.extra ?? {}),
  });

  const harness: Harness = {
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

let currentHarness: Harness | null = null;

describe("RedQueen orchestrator", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-orch-"));
    dbPath = join(tempDir, "redqueen.db");
    skillsDir = join(tempDir, "skills");
    auditPath = join(tempDir, "audit.log");
    mkdirSync(skillsDir, { recursive: true });
    // Write SKILL.md for every skill referenced by default phases
    writeSkill("spec-researcher");
    writeSkill("spec-designer");
    writeSkill("spec-writer");
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

  it("processes a task end-to-end and advances phase", async () => {
    // Worker fails on subsequent runs so we don't cascade through the whole pipeline
    let runCount = 0;
    const phasesSeen: (string | null)[] = [];
    const h = setupHarness(() => {
      runCount++;
      phasesSeen.push(h.issueTracker.phases.get("PROJ-1") ?? null);
      if (runCount === 1) {
        return Promise.resolve({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        });
      }
      return Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 0,
        summary: "",
        error: "stop cascade",
      });
    });
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });

    await runUntil(h, () => runCount >= 2);

    // The first run saw coding phase; orchestrator advanced to code-review after
    expect(phasesSeen[0]).toBe("coding");
    expect(phasesSeen[1]).toBe("code-review");
  });

  it("skips stale task when issue is at human gate", async () => {
    const h = setupHarness(() =>
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "done",
        error: null,
      }),
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
      return Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 1,
        summary: "",
        error: "boom",
      });
    });
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });

    await runUntilAfterRuns(h, 3, 3000);

    // Initial + 2 retries = 3 total attempts
    expect(attempts).toBe(3);
  });

  it("respects agent-changed phase", async () => {
    let runCount = 0;
    const h = setupHarness(() => {
      runCount++;
      if (runCount === 1) {
        // First run: simulate agent changing phase to "coding"
        h.issueTracker.phases.set("PROJ-1", "coding");
        return Promise.resolve({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "returned to coding",
          error: null,
        });
      }
      // Subsequent runs fail so the pipeline halts after the second run
      return Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 0,
        summary: "",
        error: "halt cascade",
      });
    });
    h.pipelineState.create("PROJ-1", "code-review");
    h.issueTracker.phases.set("PROJ-1", "code-review");
    h.queue.enqueue({ type: "code-review", issueId: "PROJ-1" });

    // The orchestrator should respect the agent-changed phase and move pipeline state to coding
    await runUntil(h, () => h.pipelineState.get("PROJ-1")?.currentPhase === "coding");

    expect(h.pipelineState.get("PROJ-1")?.currentPhase).toBe("coding");
  });

  it("processes new-ticket tasks without a worker", async () => {
    // Snapshot tracker state on the FIRST worker invocation — at that point
    // new-ticket is complete and we're still at spec-research+ai (the worker
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
      return Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 0,
        summary: "",
        error: null,
      });
    });
    h.queue.enqueue({ type: "new-ticket", issueId: "PROJ-1" });

    // Run until the worker ran at least once — that's our snapshot point.
    await runUntil(h, () => h.runs.length >= 1);

    expect(snapshot.phase).toBe("spec-research");
    expect(snapshot.assignment).toBe("ai");
  });

  it("performs crash recovery for working tasks", async () => {
    const h = setupHarness(() =>
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "done",
        error: null,
      }),
    );
    // Simulate a crashed state: task is "working", orchestrator state also working
    const task = h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });
    h.queue.markWorking(task.id);
    h.orchestratorState.setStatus("working");
    h.orchestratorState.setCurrentTaskId(task.id);
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "complete");

    // Task got re-queued and processed
    const stored = h.queue.getTask(task.id);
    expect(stored?.status).toBe("complete");
  });

  it("assigns to human when advancing to human gate", async () => {
    // spec-writing -> spec-review (human). spec-writing succeeds and the
    // orchestrator parks the ticket at the spec-review human gate.
    const h = setupHarness(() =>
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "done",
        error: null,
      }),
    );
    h.pipelineState.create("PROJ-1", "spec-writing");
    h.issueTracker.phases.set("PROJ-1", "spec-writing");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-1" });

    await runUntil(h, () => h.issueTracker.assignments.get("PROJ-1") === "human");

    expect(h.issueTracker.phases.get("PROJ-1")).toBe("spec-review");
    expect(h.issueTracker.assignments.get("PROJ-1")).toBe("human");
    expect(h.queue.hasOpenTask("PROJ-1", "spec-review")).toBe(false);
  });

  it("fails gracefully when skill file is missing", async () => {
    rmSync(join(skillsDir, "coder"), { recursive: true, force: true });
    const h = setupHarness(() => {
      throw new Error("worker should not run — skill missing");
    });
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    const task = h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "failed");

    const stored = h.queue.getTask(task.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.result).toContain("Skill not found");
  });

  it("updates priorContext from worker summary", async () => {
    const h = setupHarness(() =>
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "handoff notes for next phase",
        error: null,
      }),
    );
    h.pipelineState.create("PROJ-1", "coding");
    h.issueTracker.phases.set("PROJ-1", "coding");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });

    await runUntilAfterRuns(h, 1);

    const record = h.pipelineState.get("PROJ-1");
    expect(record?.priorContext).toBe("handoff notes for next phase");
  });

  it("syncs out-of-sync phase before dispatch", async () => {
    const h = setupHarness(() =>
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "done",
        error: null,
      }),
    );
    h.pipelineState.create("PROJ-1", "coding");
    // Issue is in testing but queue has a coding task — tracker is out of sync but not at a human gate
    h.issueTracker.phases.set("PROJ-1", "testing");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-1" });

    await runUntil(h, () => h.issueTracker.calls.some((c) => c === "setPhase:PROJ-1:coding"));

    expect(h.issueTracker.calls.some((c) => c === "setPhase:PROJ-1:coding")).toBe(true);
  });

  it("creates reconciliation task on startup", async () => {
    const h = setupHarness(() =>
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "done",
        error: null,
      }),
    );
    h.issueTracker.listByPhaseResults.set("coding", [makeIssue("PROJ-99", "coding")]);
    h.issueTracker.phases.set("PROJ-99", "coding");
    h.pipelineState.create("PROJ-99", "coding");

    await runUntilAfterRuns(h, 1, 3000);

    // Task got created by reconciler and processed
    expect(h.runs.length).toBeGreaterThanOrEqual(1);
  });

  it("new-ticket persists delegator from task metadata", async () => {
    const h = setupHarness(() =>
      Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 0,
        summary: "",
        error: "stop cascade",
      }),
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
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "done",
        error: null,
      }),
    );
    h.pipelineState.create("PROJ-50", "spec-writing", "justin-50");
    h.issueTracker.phases.set("PROJ-50", "spec-writing");
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
      return Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 1,
        summary: "",
        error: "stop cascade",
      });
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

  it("skips spec re-fetch for the entry phase (spec-research)", async () => {
    const h = setupHarness(() =>
      Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 1,
        summary: "",
        error: "stop cascade",
      }),
    );
    h.pipelineState.create("PROJ-71", "spec-research");
    h.issueTracker.phases.set("PROJ-71", "spec-research");
    // Tracker has a spec value; the orchestrator must not pull it for the entry
    // phase (nothing to sync before the spec is first authored).
    h.issueTracker.specs.set("PROJ-71", "pre-existing");
    h.queue.enqueue({ type: "spec-research", issueId: "PROJ-71" });

    await runUntilAfterRuns(h, 1);

    const record = h.pipelineState.get("PROJ-71");
    expect(record?.specContent).toBeNull();
  });

  it("auto-transitions human-review -> code-feedback when PR exists", async () => {
    const h = setupHarness(() =>
      Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 1,
        summary: "",
        error: "stop cascade",
      }),
    );
    h.pipelineState.create("PROJ-80", "human-review");
    h.pipelineState.updatePrNumber("PROJ-80", 42);
    h.issueTracker.phases.set("PROJ-80", "human-review");
    h.queue.enqueue({ type: "code-feedback", issueId: "PROJ-80" });

    await runUntilAfterRuns(h, 1);

    const transitionIdx = h.issueTracker.calls.indexOf("setPhase:PROJ-80:code-feedback");
    expect(transitionIdx).toBeGreaterThanOrEqual(0);
    expect(h.issueTracker.calls.indexOf("assignToAi:PROJ-80")).toBeGreaterThan(transitionIdx);
    expect(h.runs.length).toBeGreaterThanOrEqual(1);
  });

  it("auto-transitions spec-review -> spec-writing on rework", async () => {
    const h = setupHarness(() =>
      Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 1,
        summary: "",
        error: "stop cascade",
      }),
    );
    h.pipelineState.create("PROJ-81", "spec-review");
    h.issueTracker.phases.set("PROJ-81", "spec-review");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-81" });

    await runUntilAfterRuns(h, 1);

    const transitionIdx = h.issueTracker.calls.indexOf("setPhase:PROJ-81:spec-writing");
    expect(transitionIdx).toBeGreaterThanOrEqual(0);
    expect(h.issueTracker.calls.indexOf("assignToAi:PROJ-81")).toBeGreaterThan(transitionIdx);
    expect(h.runs.length).toBeGreaterThanOrEqual(1);
  });

  it("does not auto-transition when task type is not the gate rework", async () => {
    const h = setupHarness(() => {
      throw new Error("worker should not run — task must be marked stale");
    });
    h.pipelineState.create("PROJ-82", "human-review");
    h.pipelineState.updatePrNumber("PROJ-82", 50);
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
      Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 1,
        summary: "",
        error: "stop cascade",
      }),
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
      Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 1,
        summary: "",
        error: "stop cascade",
      }),
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
      return Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 1,
        summary: "",
        error: "stop cascade",
      });
    });
    h.pipelineState.create("PROJ-92", "human-review");
    h.pipelineState.updatePrNumber("PROJ-92", 42);
    h.issueTracker.phases.set("PROJ-92", "human-review");
    h.queue.enqueue({ type: "code-feedback", issueId: "PROJ-92" });

    await runUntilAfterRuns(h, 1);

    expect(phaseAtDispatch).toBe("code-feedback");
  });

  it("calls dismissStaleReviews after a requiresPr phase succeeds", async () => {
    const h = setupHarness(() =>
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "addressed feedback",
        error: null,
      }),
    );
    h.pipelineState.create("PROJ-100", "code-feedback");
    h.pipelineState.updatePrNumber("PROJ-100", 77);
    h.issueTracker.phases.set("PROJ-100", "code-feedback");
    h.queue.enqueue({ type: "code-feedback", issueId: "PROJ-100" });

    await runUntil(h, () => h.sourceControl.calls.includes("dismissStaleReviews:77"));

    expect(h.sourceControl.calls).toContain("dismissStaleReviews:77");
  });

  it("skips dismissStaleReviews when phase does not require PR", async () => {
    // coding succeeds but does not have requiresPr: true
    let runCount = 0;
    const h = setupHarness(() => {
      runCount++;
      if (runCount === 1) {
        return Promise.resolve({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "done",
          error: null,
        });
      }
      return Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 0,
        summary: "",
        error: "stop cascade",
      });
    });
    h.pipelineState.create("PROJ-101", "coding");
    h.pipelineState.updatePrNumber("PROJ-101", 78);
    h.issueTracker.phases.set("PROJ-101", "coding");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-101" });

    await runUntilAfterRuns(h, 1);

    expect(h.sourceControl.calls.some((c) => c.startsWith("dismissStaleReviews"))).toBe(false);
  });

  it("skips dismissStaleReviews when prNumber is null", async () => {
    const h = setupHarness(() =>
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "done",
        error: null,
      }),
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
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "addressed",
        error: null,
      }),
    );
    h.sourceControl.dismissStaleReviewsThrows = true;
    h.pipelineState.create("PROJ-103", "code-feedback");
    h.pipelineState.updatePrNumber("PROJ-103", 99);
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
      Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 1,
        summary: "",
        error: "rejected",
      }),
    );
    h.pipelineState.create("PROJ-60", "code-review", "justin-60");
    h.issueTracker.phases.set("PROJ-60", "code-review");
    for (let i = 0; i < 10; i++) {
      h.pipelineState.incrementReviewIterations("PROJ-60");
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
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "done",
        error: null,
      }),
    );
    h.pipelineState.create("PROJ-201", "coding");
    h.issueTracker.phases.set("PROJ-201", "coding");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-201" });

    await runUntilAfterRuns(h, 1);

    expect(h.issueTracker.calls).toContain("markInProgress:PROJ-201");
  });

  it("Gap 1: swallows markInProgress failures, worker still dispatches", async () => {
    const h = setupHarness(() =>
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "done",
        error: null,
      }),
    );
    h.pipelineState.create("PROJ-202", "coding");
    h.issueTracker.phases.set("PROJ-202", "coding");
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
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "done",
        error: null,
      }),
    );
    // Remove the reviewer skill file to force "Skill not found"
    rmSync(join(skillsDir, "reviewer"), { recursive: true, force: true });
    h.pipelineState.create("PROJ-203", "code-review");
    h.issueTracker.phases.set("PROJ-203", "code-review");
    h.queue.enqueue({ type: "code-review", issueId: "PROJ-203" });

    await runUntil(h, () => h.queue.listByStatus("failed").some((t) => t.issueId === "PROJ-203"));

    expect(h.issueTracker.calls).not.toContain("markInProgress:PROJ-203");
  });

  it("Decision 9: rework via .rework resets review_iterations and increments feedback_iterations", async () => {
    let snapshot: { review: number; feedback: number } | undefined;
    const h = setupHarness(() => {
      const rec = h.pipelineState.get("PROJ-301");
      snapshot = { review: rec?.reviewIterations ?? -1, feedback: rec?.feedbackIterations ?? -1 };
      return Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 1,
        summary: "",
        error: "stop cascade",
      });
    });
    // Real rework flow: issue parked at the human-review gate (pipeline_state AND
    // tracker), PR present, a code-feedback (rework target) task enqueued.
    h.pipelineState.create("PROJ-301", "human-review");
    h.pipelineState.updatePrNumber("PROJ-301", 42);
    h.pipelineState.incrementReviewIterations("PROJ-301");
    h.pipelineState.incrementReviewIterations("PROJ-301"); // review=2
    h.pipelineState.incrementFeedbackIterations("PROJ-301"); // feedback=1
    h.issueTracker.phases.set("PROJ-301", "human-review");
    h.queue.enqueue({ type: "code-feedback", issueId: "PROJ-301" });

    await runUntilAfterRuns(h, 1);

    expect(snapshot?.review).toBe(0); // reset on rework
    expect(snapshot?.feedback).toBe(2); // incremented 1 -> 2
  });

  it("Decision 9: advance via .next from a gate resets both counters", async () => {
    let snapshot: { review: number; feedback: number } | undefined;
    const h = setupHarness(() => {
      const rec = h.pipelineState.get("PROJ-310");
      snapshot = { review: rec?.reviewIterations ?? -1, feedback: rec?.feedbackIterations ?? -1 };
      return Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 1,
        summary: "",
        error: "stop cascade",
      });
    });
    // Human approved at spec-review → tracker moved to coding (.next); pipeline_state
    // lags at the gate. coding is NOT the gate's rework target, so reset both.
    h.pipelineState.create("PROJ-310", "spec-review");
    h.pipelineState.incrementReviewIterations("PROJ-310");
    h.pipelineState.incrementFeedbackIterations("PROJ-310");
    h.pipelineState.incrementFeedbackIterations("PROJ-310"); // feedback=2
    h.issueTracker.phases.set("PROJ-310", "coding");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-310" });

    await runUntilAfterRuns(h, 1);

    expect(snapshot?.review).toBe(0);
    expect(snapshot?.feedback).toBe(0);
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain("Leaving human gate spec-review via coding");
  });

  it("Decision 9: rework over the cap escalates without dispatching the rework target", async () => {
    const h = setupHarness(() => {
      throw new Error("worker should not run — rework budget exhausted");
    });
    h.pipelineState.create("PROJ-320", "human-review");
    h.pipelineState.updatePrNumber("PROJ-320", 42);
    // code-feedback.maxIterations = 3; three prior rework rounds → feedback=3.
    h.pipelineState.incrementFeedbackIterations("PROJ-320");
    h.pipelineState.incrementFeedbackIterations("PROJ-320");
    h.pipelineState.incrementFeedbackIterations("PROJ-320"); // feedback=3
    h.issueTracker.phases.set("PROJ-320", "human-review");
    const task = h.queue.enqueue({ type: "code-feedback", issueId: "PROJ-320" });

    await runUntil(h, () => h.queue.getTask(task.id)?.status === "complete");

    expect(h.runs.length).toBe(0);
    // code-feedback.escalateTo = human-review.
    expect(h.issueTracker.phases.get("PROJ-320")).toBe("human-review");
    expect(h.pipelineState.get("PROJ-320")?.feedbackIterations).toBe(4); // 3 -> 4 over-cap bump
    const stored = h.queue.getTask(task.id);
    expect(stored?.result).toContain("Rework budget exhausted");
  });

  it("spec-writing with 0 open questions + skipSpecReviewIfReady skips the gate to coding", async () => {
    const h = setupHarness(
      () => {
        const phase = h.pipelineState.get("PROJ-330")?.currentPhase;
        if (phase === "spec-writing") {
          return Promise.resolve({
            success: true,
            exitCode: 0,
            elapsed: 1,
            summary: "spec ready",
            error: null,
          });
        }
        return Promise.resolve({
          success: false,
          exitCode: 1,
          elapsed: 1,
          summary: "",
          error: "stop cascade",
        });
      },
      { skipSpecReviewIfReady: true },
    );
    h.pipelineState.create("PROJ-330", "spec-writing");
    h.pipelineState.setOpenQuestionCount("PROJ-330", 0);
    h.issueTracker.phases.set("PROJ-330", "spec-writing");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-330" });

    await runUntil(h, () => h.issueTracker.calls.includes("setPhase:PROJ-330:coding"));

    expect(h.issueTracker.calls).toContain("setPhase:PROJ-330:coding");
    expect(h.issueTracker.calls).not.toContain("setPhase:PROJ-330:spec-review");
  });

  it("spec-writing with 0 open questions but skip disabled advances to the spec-review gate", async () => {
    const h = setupHarness(() =>
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "spec ready",
        error: null,
      }),
    );
    h.pipelineState.create("PROJ-331", "spec-writing");
    h.pipelineState.setOpenQuestionCount("PROJ-331", 0);
    h.issueTracker.phases.set("PROJ-331", "spec-writing");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-331" });

    await runUntil(h, () => h.issueTracker.calls.includes("setPhase:PROJ-331:spec-review"));

    expect(h.issueTracker.calls).toContain("setPhase:PROJ-331:spec-review");
    expect(h.issueTracker.calls).not.toContain("setPhase:PROJ-331:coding");
  });

  it("spec-writing with open questions does NOT skip the gate even when skip is enabled", async () => {
    const h = setupHarness(
      () =>
        Promise.resolve({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "spec ready",
          error: null,
        }),
      { skipSpecReviewIfReady: true },
    );
    h.pipelineState.create("PROJ-332", "spec-writing");
    h.pipelineState.setOpenQuestionCount("PROJ-332", 2);
    h.issueTracker.phases.set("PROJ-332", "spec-writing");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-332" });

    await runUntil(h, () => h.issueTracker.calls.includes("setPhase:PROJ-332:spec-review"));

    expect(h.issueTracker.calls).toContain("setPhase:PROJ-332:spec-review");
    expect(h.issueTracker.calls).not.toContain("setPhase:PROJ-332:coding");
  });

  it("spec-writing routes on max(declared, parsed) and audit-logs the mismatch", async () => {
    const h = setupHarness(
      () =>
        Promise.resolve({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "spec ready",
          error: null,
        }),
      { skipSpecReviewIfReady: true },
    );
    h.pipelineState.create("PROJ-333", "spec-writing");
    // Declared 0 but parser found 2 → effective max=2 → gate, not skip.
    h.pipelineState.setOpenQuestionCount("PROJ-333", 0);
    h.pipelineState.recordSpecWrite("PROJ-333", {
      specContent: "# Spec",
      parsedOpenQuestionCount: 2,
      lastAiSpecHash: "x",
      lastAiSpecAt: "2026-05-19T12:00:00.000Z",
    });
    h.issueTracker.phases.set("PROJ-333", "spec-writing");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-333" });

    await runUntil(h, () => h.issueTracker.calls.includes("setPhase:PROJ-333:spec-review"));

    expect(h.issueTracker.calls).toContain("setPhase:PROJ-333:spec-review");
    expect(h.issueTracker.calls).not.toContain("setPhase:PROJ-333:coding");
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain("Open-question count mismatch: declared=0 parsed=2");
  });

  it("empty-spec restart (agent sets spec-research) does NOT reset feedback_iterations", async () => {
    let feedbackAtRestart: number | undefined;
    const h = setupHarness(() => {
      const phase = h.pipelineState.get("PROJ-340")?.currentPhase;
      if (phase === "spec-writing") {
        // Case 5: human cleared the spec; writer routes back to research.
        void h.issueTracker.setPhase("PROJ-340", "spec-research");
        return Promise.resolve({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "restart",
          error: null,
        });
      }
      feedbackAtRestart = h.pipelineState.get("PROJ-340")?.feedbackIterations;
      return Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 1,
        summary: "",
        error: "stop cascade",
      });
    });
    h.pipelineState.create("PROJ-340", "spec-writing");
    h.pipelineState.incrementFeedbackIterations("PROJ-340");
    h.pipelineState.incrementFeedbackIterations("PROJ-340"); // feedback=2 from prior rework
    h.issueTracker.phases.set("PROJ-340", "spec-writing");
    h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-340" });

    await runUntilAfterRuns(h, 2);

    // spec-research was reached via an agent-driven phase change, not a gate-leave,
    // so the rework budget is preserved (the restart costs one iteration).
    expect(feedbackAtRestart).toBe(2);
  });

  it("Gap 3: does not reset when leaving an automated phase", async () => {
    // Use code-review → testing pairing (both automated) with a passing
    // worker on testing. Gate-leave reset must not fire (prior phase is
    // automated) and the Alice-parity code-review-pass reset isn't in scope
    // either (the worker isn't running code-review here).
    const h = setupHarness(() =>
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "done",
        error: null,
      }),
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
        return Promise.resolve({
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "code written",
          error: null,
        });
      }
      return Promise.resolve({
        success: false,
        exitCode: 1,
        elapsed: 1,
        summary: "review failed",
        error: "blockers found",
      });
    });
    h.pipelineState.create("PROJ-304", "coding");
    h.pipelineState.incrementReviewIterations("PROJ-304");
    h.pipelineState.incrementReviewIterations("PROJ-304");
    h.pipelineState.incrementReviewIterations("PROJ-304");
    h.issueTracker.phases.set("PROJ-304", "coding");
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
      Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "approved",
        error: null,
      }),
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
      return Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "awaiting info",
        error: null,
      });
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
      return Promise.resolve({
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "blocked",
        error: null,
      });
    });
    h.pipelineState.create("PROJ-402", "coding", "reporter-99");
    h.issueTracker.phases.set("PROJ-402", "coding");
    h.queue.enqueue({ type: "coding", issueId: "PROJ-402" });

    await runUntil(h, () =>
      h.issueTracker.calls.some((c) => c.startsWith("assignToHuman:PROJ-402:")),
    );

    expect(h.issueTracker.calls).toContain("assignToHuman:PROJ-402:reporter-99");
  });
});
