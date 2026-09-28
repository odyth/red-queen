import { createSourceControlRegistry } from "../../integrations/source-control-registry.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DualWriteAuditLogger } from "../../core/audit.js";
import { buildPhaseGraph, legacyRepoConfig } from "../../core/config.js";
import type { RedQueenConfig } from "../../core/config.js";
import { RedQueenDatabase } from "../../core/database.js";
import { DEFAULT_PHASES } from "../../core/defaults.js";
import { RedQueen } from "../../core/orchestrator.js";
import { OrchestratorStateStore, PipelineStateStore } from "../../core/pipeline-state.js";
import { PhaseUsageStore } from "../../core/phase-usage.js";
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

function buildConfig(
  overrides: { project?: Partial<RedQueenConfig["project"]> } & Omit<
    Partial<RedQueenConfig>,
    "project"
  > = {},
): RedQueenConfig {
  const base: RedQueenConfig = {
    issueTracker: { type: "mock", config: {} },
    sourceControl: { type: "mock", config: { owner: "acme", repo: "e2e" } },
    project: {
      buildCommand: "npm run build",
      testCommand: "npm test",
      directory: tempDir,
      repos: [
        legacyRepoConfig({
          directory: tempDir,
          buildCommand: "npm run build",
          testCommand: "npm test",
          modules: [],
          sourceControlType: "mock",
          sourceControlConfig: { owner: "acme", repo: "e2e" },
          baseBranch: "origin/main",
        }),
      ],
      workspaceMode: false,
    },
    pipeline: {
      pollInterval: 0.05,
      maxRetries: 2,
      workerTimeout: 60,
      baseBranch: "origin/main",
      branchPrefixes: DEFAULT_BRANCH_PREFIXES,
      webhooks: {
        enabled: false,
        paths: { issueTracker: "/webhook/issue-tracker", sourceControl: "/webhook/source-control" },
      },
      cost: { enabled: false, pricing: {} },
      agent: "claude-code",
      model: "opus",
      effort: "high",
      stallThresholdMs: 60_000,
      reconcileInterval: 0.1,
      claudeBin: "/bin/sh",
      skipSpecReviewIfReady: false,
    },
    phases: DEFAULT_PHASES,
    skills: { directory: skillsDir, disabled: [] },
    dashboard: {
      enabled: false,
      port: 0,
      host: "127.0.0.1",
      allowNonLoopback: false,
      allowedHosts: [],
    },
    audit: { logFile: auditPath, retentionDays: 30 },
    service: {
      enabled: false,
      envFile: ".env",
      stdoutLog: ".redqueen/redqueen.out.log",
      stderrLog: ".redqueen/redqueen.err.log",
      restart: "on-failure",
    },
  };
  return { ...base, ...overrides, project: { ...base.project, ...overrides.project } };
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
    const phaseUsage = new PhaseUsageStore(db.db);
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
      // spec-writing writes the spec to the tracker as a simulated side effect
      // of the skill (the real prompt-writer calls `redqueen spec set`). The
      // orchestrator's empty-spec guard requires a non-empty spec to advance.
      (call) => {
        if (call.phaseName !== "spec-writing") {
          return null;
        }
        void issueTracker.setSpec("TEST-1", "## Spec\nImplement the widget.");
        return {
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "Spec drafted",
          error: null,
          usage: null,
        };
      },
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
        pipelineState.updateBranchInfo("TEST-1", "default", {
          branchName,
          prNumber: 1,
        });
        return {
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: `Created branch ${branchName} and PR #1`,
          error: null,
          usage: null,
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
      phaseUsage,
      orchestratorState,
      audit,
      issueTracker,
      sourceControls: createSourceControlRegistry([
        { name: "default", fullName: "default", adapter: sourceControl },
      ]),
      workerRunner,
      installSignalHandlers: false,
      sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
    });

    const startPromise = rq.start();

    try {
      // Phase 1: spec-writing → spec-review (human gate). The automated
      // spec-writing pass lands the ticket on the spec-review human gate.
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
      expect(pr?.state).toBe("closed");

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

  it("workspace mode: a two-repo ticket opens two PRs and finishes only after both merge", async () => {
    const apiDir = join(tempDir, "api");
    const webDir = join(tempDir, "web");
    for (const dir of [apiDir, webDir]) {
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
    }
    const repos = [
      {
        name: "api",
        path: apiDir,
        owner: "acme",
        repo: "Api",
        baseBranch: "origin/main",
        buildCommand: "npm run build:api",
        testCommand: "npm run test:api",
        modules: [],
      },
      {
        name: "web",
        path: webDir,
        owner: "acme",
        repo: "Web",
        baseBranch: "origin/main",
        buildCommand: "npm run build:web",
        testCommand: "npm run test:web",
        modules: [],
      },
    ];
    const issueTracker = new InMemoryIssueTracker({
      issues: [
        makeIssue({
          id: "TEST-2",
          summary: "Add email type",
          phase: "spec-writing",
          assignee: "ai-user",
          issueType: "feature",
        }),
      ],
    });
    const apiSc = new InMemorySourceControl();
    const webSc = new InMemorySourceControl();
    const sourceControls = createSourceControlRegistry([
      { name: "api", fullName: "acme/Api", adapter: apiSc },
      { name: "web", fullName: "acme/Web", adapter: webSc },
    ]);
    const db = new RedQueenDatabase(dbPath);
    const queue = new SqliteTaskQueue(db.db);
    const pipelineState = new PipelineStateStore(db.db, ["api", "web"]);
    const phaseUsage = new PhaseUsageStore(db.db);
    const orchestratorState = new OrchestratorStateStore(db.db);
    const audit = new DualWriteAuditLogger(db.db, auditPath);
    const workerCalls: string[] = [];
    const workerContexts = new Map<string, unknown>();
    const branchName = "feature/TEST-2";
    const workerRunner = createFakeWorkerRunner([
      (call) => {
        workerCalls.push(call.phaseName);
        const contextYaml = /^```yaml context\n([\s\S]*?)\n```/.exec(call.promptBody)?.[1];
        workerContexts.set(call.phaseName, parseYaml(contextYaml ?? ""));
        return null;
      },
      (call) => {
        if (call.phaseName !== "spec-writing") {
          return null;
        }
        // Simulate the prompt-writer's spec set and spec meta --repos side effects.
        void issueTracker.setSpec("TEST-2", "## Spec\n## Repos in Scope\n- api\n- web\n");
        pipelineState.setScope("TEST-2", ["api", "web"]);
        return {
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "Spec drafted",
          error: null,
          usage: null,
          reportedCostUsd: null,
        };
      },
      (call) => {
        if (call.phaseName !== "coding") {
          return null;
        }
        for (const [name, sc] of [
          ["api", apiSc],
          ["web", webSc],
        ] as const) {
          sc.branches.add(branchName);
          void sc.createPullRequest({
            title: "TEST-2: Add email type",
            body: "Implements the scoped email changes.",
            head: branchName,
            base: "main",
            draft: false,
          });
          // Separate adapters deliberately allocate the same PR number.
          pipelineState.updateBranchInfo("TEST-2", name, {
            branchName,
            prNumber: 1,
            prBaseBranch: "main",
          });
        }
        return {
          success: true,
          exitCode: 0,
          elapsed: 1,
          summary: "Two PRs opened",
          error: null,
          usage: null,
          reportedCostUsd: null,
        };
      },
      phaseRule("code-review", "Review approved"),
      phaseRule("testing", "Tests pass"),
    ]);
    const config = buildConfig({
      sourceControl: { type: "mock", config: {} },
      project: {
        directory: tempDir,
        repos,
        workspaceMode: true,
        buildCommand: undefined,
        testCommand: undefined,
      },
    });
    const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), config);
    const rq = new RedQueen({
      runtime,
      queue,
      pipelineState,
      phaseUsage,
      orchestratorState,
      audit,
      issueTracker,
      sourceControls,
      workerRunner,
      installSignalHandlers: false,
      sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
    });
    const completedPhaseSweeps = (): number =>
      issueTracker.calls.filter((call) => call === "listIssuesAssignedToAi").length;
    const startPromise = rq.start();
    try {
      await waitFor(
        () => issueTracker.phases.get("TEST-2") === "spec-review",
        "workspace issue to reach spec-review",
      );
      expect(workerContexts.get("spec-writing")).toMatchObject({
        repos: repos.map(({ name, path, buildCommand, testCommand }) => ({
          name,
          path,
          buildCommand,
          testCommand,
          inScope: false,
          branchName: null,
          prNumber: null,
          mergeCompleted: false,
        })),
      });
      expect(pipelineState.get("TEST-2")?.repos.map((row) => [row.repo, row.inScope])).toEqual([
        ["api", true],
        ["web", true],
      ]);

      // Observe actual poll sweeps to prove this gate remains held without approval.
      const sweepsAtSpecReview = completedPhaseSweeps();
      await waitFor(
        () => completedPhaseSweeps() >= sweepsAtSpecReview + 2,
        "two phase sweeps while awaiting spec approval",
      );
      expect(workerCalls).toEqual(["spec-writing"]);
      expect(pipelineState.get("TEST-2")?.currentPhase).toBe("spec-review");
      expect(issueTracker.phases.get("TEST-2")).toBe("spec-review");
      expect(issueTracker.assignments.get("TEST-2")).toBe("human");
      expect(apiSc.prs.size).toBe(0);
      expect(webSc.prs.size).toBe(0);

      await issueTracker.setPhase("TEST-2", "coding");
      await waitFor(
        () => issueTracker.phases.get("TEST-2") === "human-review",
        "workspace issue to reach human-review after spec approval",
      );
      expect(workerContexts.get("coding")).toMatchObject({
        repos: repos.map(({ name, path, buildCommand, testCommand }) => ({
          name,
          path,
          buildCommand,
          testCommand,
          inScope: true,
          branchName: null,
          prNumber: null,
          mergeCompleted: false,
        })),
      });
      for (const phase of ["code-review", "testing"]) {
        expect(workerContexts.get(phase)).toMatchObject({
          repos: repos.map(({ name }) => ({
            name,
            inScope: true,
            branchName,
            prNumber: 1,
            mergeCompleted: false,
          })),
        });
      }
      expect(apiSc.prs.size).toBe(1);
      expect(webSc.prs.size).toBe(1);
      expect(issueTracker.assignments.get("TEST-2")).toBe("human");

      // With webhooks disabled, only the poller's merged-PR scan can process these merges.
      await apiSc.mergePullRequest(1);
      await waitFor(
        () => pipelineState.getRepo("TEST-2", "api")?.branchName === null,
        "api merge and local branch cleanup",
      );
      const sweepsAfterApiMerge = completedPhaseSweeps();
      await waitFor(
        () => completedPhaseSweeps() >= sweepsAfterApiMerge + 2,
        "two phase sweeps with only api merged",
      );
      expect(pipelineState.get("TEST-2")?.currentPhase).toBe("human-review");
      expect(pipelineState.getRepo("TEST-2", "api")).toMatchObject({
        prNumber: null,
        terminalPrNumber: 1,
        mergeCompleted: true,
        branchName: null,
      });
      expect(pipelineState.getRepo("TEST-2", "web")).toMatchObject({
        prNumber: 1,
        terminalPrNumber: null,
        mergeCompleted: false,
        branchName,
      });
      expect(await webSc.getPullRequest(1)).toMatchObject({ state: "open", merged: false });
      expect(workerCalls).toEqual(["spec-writing", "coding", "code-review", "testing"]);

      await webSc.mergePullRequest(1);
      await waitFor(
        () =>
          pipelineState.get("TEST-2")?.currentPhase === "done" &&
          pipelineState.getRepo("TEST-2", "web")?.branchName === null,
        "workspace pipeline completion and final local branch cleanup",
      );
      expect(pipelineState.get("TEST-2")?.repos).toMatchObject([
        { repo: "api", prNumber: null, terminalPrNumber: 1, mergeCompleted: true },
        { repo: "web", prNumber: null, terminalPrNumber: 1, mergeCompleted: true },
      ]);
      expect(await apiSc.getPullRequest(1)).toMatchObject({ state: "closed", merged: true });
      expect(await webSc.getPullRequest(1)).toMatchObject({ state: "closed", merged: true });
      expect(workerCalls).toEqual(["spec-writing", "coding", "code-review", "testing"]);
      expect(queue.listByStatus("ready")).toHaveLength(0);
      expect(queue.listByStatus("working")).toHaveLength(0);
      expect(queue.listByStatus("deferred")).toHaveLength(0);
    } finally {
      try {
        await rq.stop();
        await startPromise;
      } finally {
        db.close();
      }
    }
  }, 30_000);
});
