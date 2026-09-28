import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DualWriteAuditLogger } from "../../core/audit.js";
import { buildPhaseGraph } from "../../core/config.js";
import { SCHEMA_SQL } from "../../core/database.js";
import { DEFAULT_PHASES } from "../../core/defaults.js";
import { PipelineStateStore } from "../../core/pipeline-state.js";
import { SqliteTaskQueue } from "../../core/queue.js";
import { reconcile } from "../../core/reconciler.js";
import { RuntimeState } from "../../core/runtime-state.js";
import type { PipelineEvent } from "../../core/types.js";
import {
  MockIssueTracker,
  MockSourceControl,
  makeIssue,
} from "../../core/__tests__/fixtures/mock-adapters.js";
import { makeTestConfig } from "../../core/__tests__/fixtures/test-config.js";
import { parseGitHubWebhookEvent } from "../../integrations/github/webhook.js";
import { createSourceControlRegistry } from "../../integrations/source-control-registry.js";
import { WebhookServer } from "../server.js";

describe("WebhookServer repository routing", () => {
  let db: BetterSqlite3.Database;
  let root: string;
  let store: PipelineStateStore;
  let queue: SqliteTaskQueue;
  let audit: DualWriteAuditLogger;
  let tracker: MockIssueTracker;
  let api: MockSourceControl;
  let web: MockSourceControl;
  let runtime: RuntimeState;
  let server: WebhookServer;
  let gitCalls: { args: string[]; cwd: string }[];
  let events: PipelineEvent[];
  let gitEffect: ((args: string[], cwd: string) => Promise<void>) | null;
  let apiLookup: MockInstance<MockSourceControl["getPullRequest"]>;
  let webLookup: MockInstance<MockSourceControl["getPullRequest"]>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rq-webhook-repos-"));
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    store = new PipelineStateStore(db, ["api", "web"]);
    queue = new SqliteTaskQueue(db);
    audit = new DualWriteAuditLogger(db, join(root, "audit.log"));
    tracker = new MockIssueTracker();
    tracker.defaultAssignedToAi = true;
    api = new MockSourceControl();
    web = new MockSourceControl();
    apiLookup = vi.spyOn(api, "getPullRequest");
    webLookup = vi.spyOn(web, "getPullRequest");
    gitCalls = [];
    events = [];
    gitEffect = null;
    runtime = new RuntimeState(
      buildPhaseGraph(DEFAULT_PHASES),
      makeTestConfig({
        issueTracker: { type: "github-issues", config: { owner: "acme", repo: "tickets" } },
        project: {
          directory: root,
          repos: ["api", "web"].map((name) => ({
            name,
            path: join(root, name),
            owner: "acme",
            repo: name,
            baseBranch: "origin/main",
            buildCommand: "build",
            testCommand: "test",
            modules: [],
          })),
        },
      }),
    );
    server = new WebhookServer({
      issueTracker: tracker,
      sourceControls: createSourceControlRegistry([
        { name: "api", fullName: "acme/api", adapter: api },
        { name: "web", fullName: "acme/web", adapter: web },
      ]),
      queue,
      pipelineState: store,
      runtime,
      audit,
      gitRunner: (args, cwd) => {
        gitCalls.push({ args, cwd });
        return gitEffect?.(args, cwd) ?? Promise.resolve();
      },
      onEvent: (event) => events.push(event),
    });
  });

  afterEach(async () => {
    await server.drain();
    db.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function dispatch(event: PipelineEvent): Promise<void> {
    return (
      server as unknown as {
        dispatchEvent(event: PipelineEvent, component: string): Promise<void>;
      }
    ).dispatchEvent(event, "test");
  }

  function merge(issueId: string, repo: string, prNumber = 7): Promise<void> {
    return dispatch({
      source: "webhook",
      type: "pr-merged",
      issueId,
      timestamp: new Date().toISOString(),
      payload: { repo, prNumber, branch: `feature/${issueId}`, base: "main" },
    });
  }

  function seed(issueId: string, repo: string, prNumber = 7, base = "main"): void {
    if (store.get(issueId) === null) {
      store.create(issueId, "human-review");
    }
    if (store.getRepo(issueId, repo) === null) {
      const scoped = store
        .listRepos(issueId)
        .filter((row) => row.inScope)
        .map((row) => row.repo);
      store.setScope(issueId, [...scoped, repo]);
    }
    store.updateBranchInfo(issueId, repo, {
      branchName: `feature/${issueId}`,
      prNumber,
      prBaseBranch: base,
    });
    tracker.phases.set(issueId, "human-review");
    const adapter = repo === "api" ? api : web;
    adapter.prs.set(prNumber, {
      number: prNumber,
      title: issueId,
      state: "open",
      merged: false,
      headBranch: `feature/${issueId}`,
      baseBranch: base,
      url: `https://example.com/${repo}/pull/${String(prNumber)}`,
      reviewDecision: null,
    });
  }

  function parsedFeedback(repo: string, number: number, pullRequest = true): PipelineEvent {
    const event = parseGitHubWebhookEvent(
      { identity: { login: "bot", accountId: "1", isBot: true } },
      { "x-github-event": "issue_comment" },
      JSON.stringify({
        action: "created",
        sender: { id: 2, login: "human" },
        repository: { full_name: repo },
        issue: {
          number,
          ...(pullRequest
            ? { pull_request: { url: "https://api.github.com/repos/a/b/pulls/7" } }
            : {}),
        },
      }),
    );
    if (event === null) {
      throw new Error("Expected feedback event");
    }
    return event;
  }

  it("merges colliding PR numbers independently and cancels tasks only on final completion", async () => {
    seed("PROJ-1", "api");
    seed("PROJ-1", "web");
    const worktree = join(root, ".redqueen", "worktrees", "PROJ-1", "api");
    mkdirSync(worktree, { recursive: true });
    store.updateBranchInfo("PROJ-1", "api", { worktreePath: worktree });
    const pending = queue.enqueue({ issueId: "PROJ-1", type: "code-feedback" });

    await merge("PROJ-1", "ACME/Api");

    expect(store.getRepo("PROJ-1", "api")).toMatchObject({
      prNumber: null,
      terminalPrNumber: 7,
      mergeCompleted: true,
      branchName: null,
      worktreePath: null,
    });
    expect(store.getRepo("PROJ-1", "web")?.prNumber).toBe(7);
    expect(store.get("PROJ-1")?.currentPhase).toBe("human-review");
    expect(queue.getTask(pending.id)?.status).toBe("ready");
    expect(gitCalls).toEqual([
      { args: ["worktree", "remove", "--force", "--", worktree], cwd: join(root, "api") },
      { args: ["branch", "-D", "--", "feature/PROJ-1"], cwd: join(root, "api") },
    ]);

    await merge("PROJ-1", "acme/web");
    expect(store.get("PROJ-1")?.currentPhase).toBe("done");
    expect(queue.getTask(pending.id)?.status).toBe("cancelled");
    expect(gitCalls.at(-1)?.cwd).toBe(join(root, "web"));
  });

  it("keeps an unstarted scoped sibling incomplete", async () => {
    seed("PROJ-1", "web");
    store.setScope("PROJ-1", ["api", "web"]);
    await merge("PROJ-1", "acme/web");
    expect(store.get("PROJ-1")?.currentPhase).toBe("human-review");
    expect(store.getRepo("PROJ-1", "api")?.mergeCompleted).toBe(false);
  });

  it("cleans a descoped merge without completing the issue", async () => {
    seed("PROJ-1", "api");
    seed("PROJ-1", "web");
    store.setScope("PROJ-1", ["web"]);
    await merge("PROJ-1", "acme/api");
    expect(store.getRepo("PROJ-1", "api")).toMatchObject({
      mergeCompleted: true,
      branchName: null,
    });
    expect(store.get("PROJ-1")?.currentPhase).toBe("human-review");
  });

  it.each(["someone/else", "missing"])("audits and drops unknown repository %s", async (repo) => {
    seed("PROJ-1", "api");
    await dispatch({
      source: repo.includes("/") ? "webhook" : "poll",
      type: "pr-merged",
      issueId: "PROJ-1",
      timestamp: new Date().toISOString(),
      payload: { prNumber: 7, ...(repo.includes("/") ? { repo } : { repoName: repo }) },
    });
    expect(store.getRepo("PROJ-1", "api")?.prNumber).toBe(7);
    expect(gitCalls).toEqual([]);
    expect(
      audit.query({ issueId: "PROJ-1" }).some((entry) => entry.message.includes("unknown repo")),
    ).toBe(true);
  });

  it("does not infer workspace scope for a known repository", async () => {
    store.create("PROJ-1", "human-review");
    await merge("PROJ-1", "acme/api");
    expect(store.listRepos("PROJ-1")).toEqual([]);
    expect(store.get("PROJ-1")?.currentPhase).toBe("human-review");
  });

  it("scans each adapter and replays only the merged row", async () => {
    seed("PROJ-1", "api");
    seed("PROJ-1", "web");
    await web.mergePullRequest(7);
    await server.reconcileMergedPrs();
    expect(apiLookup).toHaveBeenCalledWith(7);
    expect(webLookup).toHaveBeenCalledWith(7);
    expect(store.getRepo("PROJ-1", "api")?.prNumber).toBe(7);
    expect(store.getRepo("PROJ-1", "web")?.mergeCompleted).toBe(true);
    expect(events.at(-1)?.payload.repoName).toBe("web");
  });

  it.each([7, null])("sweeps partial-merge crash artifacts with PR identity %s", async (number) => {
    seed("PROJ-1", "api");
    seed("PROJ-1", "web");
    const worktree = join(root, "wt-api");
    mkdirSync(worktree);
    store.updateBranchInfo("PROJ-1", "api", { prNumber: number, worktreePath: worktree });
    expect(store.markPrMerged("PROJ-1", "api", number)).toBe("pending-others");
    await server.reconcileMergedPrs();
    expect(store.get("PROJ-1")?.currentPhase).toBe("human-review");
    expect(store.getRepo("PROJ-1", "api")).toMatchObject({ branchName: null, worktreePath: null });
    expect(gitCalls).toContainEqual({
      args: ["worktree", "remove", "--force", "--", worktree],
      cwd: join(root, "api"),
    });
    expect(api.calls).toEqual([]);
  });

  it("does not sweep artifacts from a reopened issue cycle", async () => {
    seed("PROJ-1", "api");
    store.markPrMerged("PROJ-1", "api", 7);
    store.updatePhase("PROJ-1", "coding");
    await server.reconcileMergedPrs();
    expect(gitCalls).toEqual([]);
    expect(store.getRepo("PROJ-1", "api")?.branchName).toBe("feature/PROJ-1");
    await merge("PROJ-1", "acme/api");
    expect(store.get("PROJ-1")?.currentPhase).toBe("coding");
    expect(gitCalls).toEqual([]);
  });

  it("rejects a numberless merge whose branch belongs to an earlier run", async () => {
    seed("PROJ-1", "api");
    await dispatch({
      source: "webhook",
      type: "pr-merged",
      issueId: "PROJ-1",
      timestamp: new Date().toISOString(),
      payload: { repo: "acme/api", branch: "feature/old-cycle", base: "main" },
    });
    expect(store.getRepo("PROJ-1", "api")?.prNumber).toBe(7);
    expect(gitCalls).toEqual([]);
  });

  it("retains both deferred row merges until the worker finishes", async () => {
    seed("PROJ-1", "api");
    seed("PROJ-1", "web");
    const worker = queue.enqueue({ issueId: "PROJ-1", type: "coding" });
    queue.markWorking(worker.id);
    await merge("PROJ-1", "acme/api");
    await merge("PROJ-1", "acme/web");
    expect(gitCalls).toEqual([]);
    queue.markComplete(worker.id, "finished");
    await server.retryPendingMergeCleanup("PROJ-1");
    expect(store.get("PROJ-1")?.currentPhase).toBe("done");
    expect(store.listRepos("PROJ-1").every((row) => row.mergeCompleted)).toBe(true);
    expect(gitCalls.map((call) => call.cwd)).toEqual([join(root, "api"), join(root, "web")]);
  });

  it("discards a replaced deferred PR without losing its sibling cleanup", async () => {
    seed("PROJ-1", "api");
    seed("PROJ-1", "web");
    const worker = queue.enqueue({ issueId: "PROJ-1", type: "coding" });
    queue.markWorking(worker.id);
    await merge("PROJ-1", "acme/api");
    await merge("PROJ-1", "acme/web");
    store.updatePrNumber("PROJ-1", "api", 8, "main");
    queue.markComplete(worker.id, "finished");
    await server.retryPendingMergeCleanup("PROJ-1");
    expect(store.getRepo("PROJ-1", "api")?.prNumber).toBe(8);
    expect(store.getRepo("PROJ-1", "web")?.mergeCompleted).toBe(true);
    expect(gitCalls.map((call) => call.cwd)).toEqual([join(root, "web")]);
  });

  it("refreshes only live scoped dependents in the merged repository", async () => {
    seed("PROJ-1", "api");
    seed("PROJ-2", "api", 8, "feature/PROJ-1");
    seed("PROJ-2", "web", 8, "feature/PROJ-1");
    seed("PROJ-3", "api", 9, "feature/PROJ-1");
    store.setScope("PROJ-3", ["web"]);
    seed("PROJ-4", "api", 10, "feature/PROJ-1");
    seed("PROJ-4", "web", 10);
    store.markPrMerged("PROJ-4", "api", 10);
    await merge("PROJ-1", "acme/api");
    expect(api.calls).toContain("updatePullRequestBase:8:main");
    expect(apiLookup).not.toHaveBeenCalledWith(9);
    expect(apiLookup).not.toHaveBeenCalledWith(10);
    expect(web.calls).toEqual([]);
    expect(store.getRepo("PROJ-2", "web")?.prBaseBranch).toBe("feature/PROJ-1");
    const refreshDir = join(root, ".redqueen", "worktrees", "refresh-PROJ-2", "api");
    expect(gitCalls).toContainEqual({
      args: ["worktree", "add", "--detach", refreshDir, "origin/feature/PROJ-2"],
      cwd: join(root, "api"),
    });
    expect(gitCalls).toContainEqual({
      args: ["push", "origin", "HEAD:feature/PROJ-2"],
      cwd: refreshDir,
    });
    expect(gitCalls.some((call) => call.cwd === root)).toBe(false);
  });

  it("routes real PR issue_comment without a head branch by repository and PR number", async () => {
    seed("PROJ-1", "api");
    seed("PROJ-2", "web");
    store.create("#7", "spec-review");
    await dispatch(parsedFeedback("ACME/Web", 7));
    expect(queue.hasOpenTask("PROJ-2", "code-feedback")).toBe(true);
    expect(queue.listByStatus("ready")).toHaveLength(1);
    expect(tracker.calls).toContain("getPhase:PROJ-2");
    expect(tracker.calls).not.toContain("getPhase:#7");
    expect(events.at(-1)?.issueId).toBe("PROJ-2");
  });

  it.each(["unknown", "descoped", "merged", "replaced", "reopened"])(
    "drops %s PR feedback",
    async (reason) => {
      seed("PROJ-1", "api");
      seed("PROJ-1", "web");
      if (reason === "descoped") {
        store.setScope("PROJ-1", ["web"]);
      } else if (reason === "merged") {
        store.markPrMerged("PROJ-1", "api", 7);
      } else if (reason === "replaced") {
        store.updatePrNumber("PROJ-1", "api", 8, "main");
      } else if (reason === "reopened") {
        store.markDone("PROJ-1");
        store.updatePhase("PROJ-1", "coding");
      }
      await dispatch(parsedFeedback(reason === "unknown" ? "someone/else" : "acme/api", 7));
      expect(queue.listByStatus("ready")).toEqual([]);
      expect(tracker.calls).toEqual([]);
    },
  );

  it("keeps tracker issue comments separate from colliding PR numbers", async () => {
    seed("PROJ-1", "api");
    store.create("#7", "spec-review");
    tracker.phases.set("#7", "spec-review");
    await dispatch(parsedFeedback("acme/tickets", 7, false));
    expect(queue.hasOpenTask("#7", "spec-feedback")).toBe(true);
    expect(queue.hasOpenTask("PROJ-1", "code-feedback")).toBe(false);
  });

  it("drops ordinary comments outside the configured tracker repository", async () => {
    store.create("#7", "spec-review");
    await dispatch(parsedFeedback("someone/else", 7, false));
    expect(queue.listByStatus("ready")).toEqual([]);
    expect(tracker.calls).toEqual([]);
  });

  it.each(["rq:active", "rq:phase:coding"])(
    "routes issue label %s only from the configured tracker repo",
    async (label) => {
      store.create("#7", "spec-writing");
      tracker.phases.set("#7", "coding");
      for (const repo of ["someone/else", "acme/api", "ACME/Tickets"]) {
        const event = parseGitHubWebhookEvent(
          { identity: { login: "bot", accountId: "1", isBot: true } },
          { "x-github-event": "issues" },
          JSON.stringify({
            action: "labeled",
            repository: { full_name: repo },
            issue: { number: 7 },
            label: { name: label },
          }),
        );
        if (event === null) {
          throw new Error("Expected issue label event");
        }
        await dispatch(event);
        expect(queue.hasOpenTask("#7", "coding")).toBe(repo === "ACME/Tickets");
      }
    },
  );

  it("retains failed worktree cleanup for the partial-merge restart sweep", async () => {
    seed("PROJ-1", "api");
    seed("PROJ-1", "web");
    const worktree = join(root, "wt-api");
    mkdirSync(worktree);
    store.updateBranchInfo("PROJ-1", "api", { worktreePath: worktree });
    gitEffect = () => Promise.reject(new Error("worktree is busy"));
    await merge("PROJ-1", "acme/api");
    expect(store.getRepo("PROJ-1", "api")).toMatchObject({
      mergeCompleted: true,
      branchName: "feature/PROJ-1",
      worktreePath: worktree,
    });
    gitEffect = null;
    await server.reconcileMergedPrs();
    expect(store.getRepo("PROJ-1", "api")).toMatchObject({ branchName: null, worktreePath: null });
  });

  it.each([true, false])(
    "handles branch deletion failure with missing branch = %s",
    async (missing) => {
      seed("PROJ-1", "api");
      gitEffect = (args) => {
        if (args[0] === "branch") {
          return Promise.reject(new Error("delete failed"));
        }
        return missing
          ? Promise.reject(Object.assign(new Error("absent"), { code: 1 }))
          : Promise.resolve();
      };
      await merge("PROJ-1", "acme/api");
      expect(store.getRepo("PROJ-1", "api")?.branchName).toBe(missing ? null : "feature/PROJ-1");
      gitEffect = null;
      await server.reconcileMergedPrs();
      expect(store.getRepo("PROJ-1", "api")?.branchName).toBeNull();
    },
  );

  it("does not delete or clear a replacement branch after awaited worktree cleanup", async () => {
    seed("PROJ-1", "api");
    const worktree = join(root, "old-worktree");
    mkdirSync(worktree);
    store.updateBranchInfo("PROJ-1", "api", { worktreePath: worktree });
    gitEffect = () => {
      store.updatePhase("PROJ-1", "coding");
      store.updateBranchInfo("PROJ-1", "api", {
        prNumber: 8,
        branchName: "feature/replacement",
        worktreePath: join(root, "new-worktree"),
      });
      return Promise.resolve();
    };
    await merge("PROJ-1", "acme/api");
    expect(gitCalls.some((call) => call.args[0] === "branch")).toBe(false);
    expect(store.getRepo("PROJ-1", "api")).toMatchObject({
      prNumber: 8,
      branchName: "feature/replacement",
      worktreePath: join(root, "new-worktree"),
    });
  });

  it("rechecks scope after a dependent lookup before retargeting", async () => {
    seed("PROJ-1", "api");
    seed("PROJ-2", "api", 8, "feature/PROJ-1");
    apiLookup.mockImplementation((number) => {
      store.setScope("PROJ-2", ["web"]);
      return Promise.resolve(api.prs.get(number) ?? null);
    });
    await merge("PROJ-1", "acme/api");
    expect(api.calls).not.toContain("updatePullRequestBase:8:main");
    expect(gitCalls.some((call) => call.args[0] === "push")).toBe(false);
  });

  it("does not overwrite replacement PR state after awaited retargeting", async () => {
    seed("PROJ-1", "api");
    seed("PROJ-2", "api", 8, "feature/PROJ-1");
    vi.spyOn(api, "updatePullRequestBase").mockImplementation(() => {
      store.updatePrNumber("PROJ-2", "api", 9, "new-base");
      return Promise.resolve();
    });
    await merge("PROJ-1", "acme/api");
    expect(store.getRepo("PROJ-2", "api")).toMatchObject({ prNumber: 9, prBaseBranch: "new-base" });
    expect(gitCalls.some((call) => call.args[0] === "push")).toBe(false);
  });

  it("does not push a dependent branch replaced while its refresh merge awaited", async () => {
    seed("PROJ-1", "api");
    seed("PROJ-2", "api", 8, "feature/PROJ-1");
    gitEffect = (args) => {
      if (args[0] === "merge") {
        store.updatePrNumber("PROJ-2", "api", 9, "main");
      }
      return Promise.resolve();
    };
    await merge("PROJ-1", "acme/api");
    expect(gitCalls.some((call) => call.args[0] === "push")).toBe(false);
  });

  it("does not enqueue PR feedback when its PR changes during the tracker read", async () => {
    seed("PROJ-1", "api");
    vi.spyOn(tracker, "getPhase").mockImplementation(() => {
      store.updatePrNumber("PROJ-1", "api", 8, "main");
      return Promise.resolve("human-review");
    });
    await dispatch(parsedFeedback("acme/api", 7));
    expect(queue.listByStatus("ready")).toEqual([]);
    expect(store.get("PROJ-1")?.currentPhase).toBe("human-review");
  });

  it("keeps final merge completion when it races the feedback tracker transition", async () => {
    seed("PROJ-1", "api");
    let releasePhase: (() => void) | undefined;
    let phaseStarted: (() => void) | undefined;
    const pendingPhase = new Promise<void>((resolve) => {
      releasePhase = resolve;
    });
    const started = new Promise<void>((resolve) => {
      phaseStarted = resolve;
    });
    vi.spyOn(tracker, "setPhase").mockImplementation(async (issueId, phase) => {
      phaseStarted?.();
      await pendingPhase;
      tracker.phases.set(issueId, phase);
    });
    vi.spyOn(tracker, "listIssuesByPhase").mockImplementation((phase) =>
      Promise.resolve(tracker.phases.get("PROJ-1") === phase ? [makeIssue("PROJ-1", phase)] : []),
    );
    const feedback = dispatch(parsedFeedback("acme/api", 7));
    await started;
    const merging = merge("PROJ-1", "acme/api");
    // Let the independently delivered merge run while the tracker call waits.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    releasePhase?.();
    await Promise.all([feedback, merging]);
    expect(store.get("PROJ-1")?.currentPhase).toBe("done");
    expect(store.getRepo("PROJ-1", "api")?.mergeCompleted).toBe(true);
    expect(tracker.phases.get("PROJ-1")).toBe("code-feedback");
    const deps = { issueTracker: tracker, queue, runtime, pipelineState: store, audit };
    expect((await reconcile(deps)).tasksCreated).toBe(0);
    expect(queue.listByStatus("ready")).toEqual([]);
    tracker.phases.set("PROJ-1", "coding");
    expect((await reconcile(deps)).tasksCreated).toBe(1);
    expect(queue.hasOpenTask("PROJ-1", "coding")).toBe(true);
  });

  it("keeps different issues independent while a feedback transition waits", async () => {
    seed("PROJ-1", "api");
    seed("PROJ-2", "web");
    let releasePhase: (() => void) | undefined;
    let phaseStarted: (() => void) | undefined;
    const pendingPhase = new Promise<void>((resolve) => {
      releasePhase = resolve;
    });
    const started = new Promise<void>((resolve) => {
      phaseStarted = resolve;
    });
    vi.spyOn(tracker, "setPhase").mockImplementation(async (issueId, phase) => {
      phaseStarted?.();
      await pendingPhase;
      tracker.phases.set(issueId, phase);
    });
    const feedback = dispatch(parsedFeedback("acme/api", 7));
    await started;
    const merging = merge("PROJ-2", "acme/web");
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(store.get("PROJ-2")?.currentPhase).toBe("done");
      expect(store.get("PROJ-1")?.currentPhase).toBe("human-review");
    } finally {
      releasePhase?.();
      await Promise.all([feedback, merging]);
    }
  });

  it("accepts later same-issue events after a dispatch rejection", async () => {
    const event: PipelineEvent = {
      source: "webhook",
      type: "phase-change",
      issueId: "PROJ-1",
      timestamp: new Date().toISOString(),
      payload: { phase: "unknown" },
    };
    vi.spyOn(audit, "log").mockImplementationOnce(() => {
      throw new Error("audit failed");
    });
    await expect(dispatch(event)).rejects.toThrow("audit failed");
    await dispatch({ ...event, payload: { phase: "spec-writing" } });
    expect(queue.hasOpenTask("PROJ-1", "spec-writing")).toBe(true);
  });

  it("drain waits for pending and queued dispatches", async () => {
    seed("PROJ-1", "api");
    let releaseCleanup: (() => void) | undefined;
    let cleanupStarted: (() => void) | undefined;
    const pendingCleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const started = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    gitEffect = () => {
      cleanupStarted?.();
      return pendingCleanup;
    };
    const merging = merge("PROJ-1", "acme/api");
    await started;
    let drained = false;
    const draining = server.drain().then(() => {
      drained = true;
    });
    const laterEvent = dispatch({
      source: "webhook",
      type: "phase-change",
      issueId: "PROJ-1",
      timestamp: new Date().toISOString(),
      payload: { phase: "coding" },
    });
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(drained).toBe(false);
      expect(queue.listByStatus("ready")).toEqual([]);
    } finally {
      releaseCleanup?.();
      await Promise.all([merging, laterEvent, draining]);
    }
    expect(drained).toBe(true);
    expect(store.getRepo("PROJ-1", "api")?.branchName).toBeNull();
    expect(queue.hasOpenTask("PROJ-1", "coding")).toBe(true);
  });
});
