import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DualWriteAuditLogger } from "../../core/audit.js";
import { buildPhaseGraph } from "../../core/config.js";
import type { RedQueenConfig } from "../../core/config.js";
import { RedQueenDatabase } from "../../core/database.js";
import { DEFAULT_PHASES } from "../../core/defaults.js";
import { RedQueen } from "../../core/orchestrator.js";
import { OrchestratorStateStore, PipelineStateStore } from "../../core/pipeline-state.js";
import { SqliteTaskQueue } from "../../core/queue.js";
import { RuntimeState } from "../../core/runtime-state.js";
import { createFakeWorkerRunner, phaseRule } from "../fakes/fake-worker-runner.js";
import {
  InMemoryIssueTracker,
  InMemorySourceControl,
  makeIssue,
} from "../fakes/in-memory-adapters.js";

let tempDir: string;
let dbPath: string;
let auditPath: string;
let skillsDir: string;

const DEFAULT_BRANCH_PREFIXES: Record<string, string> = {
  feature: "feature/",
  bug: "bugfix/",
  task: "improvement/",
  default: "feature/",
};

function writeSkill(name: string): void {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}\nFake skill for E2E harness.\n`);
}

function buildConfig(overrides: Partial<RedQueenConfig> = {}): RedQueenConfig {
  const base: RedQueenConfig = {
    issueTracker: { type: "mock", config: {} },
    sourceControl: { type: "mock", config: { owner: "acme", repo: "e2e" } },
    project: {
      buildCommand: "npm run build",
      testCommand: "npm test",
      directory: tempDir,
    },
    pipeline: {
      pollInterval: 0.05,
      maxRetries: 2,
      workerTimeout: 60,
      baseBranch: "origin/main",
      branchPrefixes: DEFAULT_BRANCH_PREFIXES,
      webhooks: { enabled: false },
      model: "opus",
      effort: "high",
      stallThresholdMs: 60_000,
      reconcileInterval: 0.1,
      claudeBin: "/bin/sh",
    },
    phases: DEFAULT_PHASES,
    skills: { directory: skillsDir, disabled: [] },
    dashboard: { enabled: false, port: 0, host: "127.0.0.1" },
    audit: { logFile: auditPath, retentionDays: 30 },
  };
  return { ...base, ...overrides };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out after ${String(timeoutMs)}ms waiting for: ${message}`);
}

describe("E2E: orchestrator full pipeline loop", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-e2e-"));
    dbPath = join(tempDir, "redqueen.db");
    auditPath = join(tempDir, "audit.log");
    skillsDir = join(tempDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeSkill("prompt-writer");
    writeSkill("coder");
    writeSkill("reviewer");
    writeSkill("tester");
    writeSkill("comment-handler");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("drives one ticket through spec-writing → ... → human-review → merge", async () => {
    const seededIssue = makeIssue({
      id: "TEST-1",
      summary: "Add a widget",
      phase: "spec-writing",
      assignee: "ai-user",
      issueType: "feature",
    });
    const issueTracker = new InMemoryIssueTracker({ issues: [seededIssue] });
    const sourceControl = new InMemorySourceControl();

    const db = new RedQueenDatabase(dbPath);
    const queue = new SqliteTaskQueue(db.db);
    const pipelineState = new PipelineStateStore(db.db);
    const orchestratorState = new OrchestratorStateStore(db.db);
    const audit = new DualWriteAuditLogger(db.db, auditPath);
    const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);

    // Track which phases the fake worker was invoked for, so the test can
    // simulate skill side-effects (creating a PR after coding) precisely.
    const workerCalls: string[] = [];
    const workerRunner = createFakeWorkerRunner([
      (call) => {
        workerCalls.push(call.phaseName);
        return null; // fall through to phaseRule matchers below
      },
      phaseRule("spec-writing", "Spec drafted"),
      // Coding creates a branch and PR as a simulated side effect of the skill.
      (call) => {
        if (call.phaseName !== "coding") {
          return null;
        }
        const branchName = "feature/TEST-1-widget";
        sourceControl.branches.add(branchName);
        void sourceControl.createPullRequest({
          title: "TEST-1: Add a widget",
          body: "Implements widget.",
          head: branchName,
          base: "main",
          draft: false,
        });
        pipelineState.updateBranchInfo("TEST-1", {
          branchName,
          prNumber: 1,
        });
        return {
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: `Created branch ${branchName} and PR #1`,
          error: null,
        };
      },
      phaseRule("code-review", "Review approved"),
      phaseRule("testing", "Tests pass"),
    ]);

    const config = buildConfig();

    const runtime = new RuntimeState(phaseGraph, config);

    const rq = new RedQueen({
      runtime,
      queue,
      pipelineState,
      orchestratorState,
      audit,
      issueTracker,
      sourceControl,
      workerRunner,
      installSignalHandlers: false,
      sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
    });

    const startPromise = rq.start();

    try {
      // Phase 1: spec-writing (automated) → advances to spec-review (human gate).
      await waitFor(
        () => issueTracker.phases.get("TEST-1") === "spec-review",
        "issue to advance to spec-review",
      );
      expect(workerCalls).toContain("spec-writing");
      expect(issueTracker.assignments.get("TEST-1")).toBe("human");

      // Simulate human approval: flip the phase to coding. The poller's next
      // reconcile tick picks this up and enqueues a coding task.
      await issueTracker.setPhase("TEST-1", "coding");

      // Phase 3: coding → code-review (automated → automated).
      await waitFor(() => workerCalls.includes("coding"), "coder to run");
      await waitFor(() => workerCalls.includes("code-review"), "reviewer to run");

      // Phase 5: testing → human-review (automated → human gate).
      await waitFor(() => workerCalls.includes("testing"), "tester to run");
      await waitFor(
        () => issueTracker.phases.get("TEST-1") === "human-review",
        "issue to advance to human-review",
      );

      // Simulate human-review approval: merge the PR and mark the issue done.
      await sourceControl.mergePullRequest(1);
      await issueTracker.setPhase("TEST-1", "done");
      pipelineState.updatePhase("TEST-1", "done");

      await waitFor(
        () => pipelineState.get("TEST-1")?.currentPhase === "done",
        "pipeline to reach done",
      );
    } finally {
      await rq.stop();
      await startPromise.catch(() => {
        // main loop exits cleanly on shutdown
      });
    }

    // Assertions run while db is still open.
    try {
      expect(workerCalls).toEqual(["spec-writing", "coding", "code-review", "testing"]);
      expect(queue.listByStatus("ready")).toHaveLength(0);
      expect(queue.listByStatus("working")).toHaveLength(0);
      expect(pipelineState.get("TEST-1")?.currentPhase).toBe("done");

      const pr = await sourceControl.getPullRequest(1);
      expect(pr).not.toBeNull();
      expect(pr?.state).toBe("merged");

      const auditEntries = audit.query({ issueId: "TEST-1", limit: 200 });
      const phaseCompletions = auditEntries
        .filter((e) => e.message.includes(" completed in "))
        .map((e) => e.message);
      expect(phaseCompletions.some((m) => m.includes("spec-writing"))).toBe(true);
      expect(phaseCompletions.some((m) => m.includes("coding"))).toBe(true);
      expect(phaseCompletions.some((m) => m.includes("code-review"))).toBe(true);
      expect(phaseCompletions.some((m) => m.includes("testing"))).toBe(true);
    } finally {
      db.close();
    }
  }, 30_000);
});
