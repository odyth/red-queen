import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../../core/database.js";
import { PipelineStateStore } from "../../core/pipeline-state.js";
import { executeStackSetup } from "../stack.js";
import type { GitRun, StackSetupIo } from "../stack.js";
import { makeTestConfig } from "../../core/__tests__/fixtures/test-config.js";
import { MockIssueTracker, makeIssue } from "../../core/__tests__/fixtures/mock-adapters.js";

let tmp: string;
let db: BetterSqlite3.Database;

interface StackHarness {
  io: Omit<StackSetupIo, "git">;
  issueTracker: MockIssueTracker;
  pipelineState: PipelineStateStore;
  projectDir: string;
}

function mkStackHarness(projectDir: string): StackHarness {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  const pipelineState = new PipelineStateStore(db, ["app"]);
  const issueTracker = new MockIssueTracker();
  issueTracker.issues.set("#2", { ...makeIssue("#2", "coding"), issueType: "feature" });
  const config = makeTestConfig({
    project: { buildCommand: "b", testCommand: "t", directory: projectDir },
  });
  return {
    io: { issueId: "#2", spec: false, config, issueTracker, pipelineState },
    issueTracker,
    pipelineState,
    projectDir,
  };
}

function satisfyBlockerAtGate(h: StackHarness, id: string, branch: string): void {
  h.issueTracker.blockedBy.set("#2", [{ id, closed: false }]);
  h.issueTracker.phases.set(id, "human-review");
  h.pipelineState.create(id, "human-review");
  h.pipelineState.updateBranchInfo(id, "app", { branchName: branch, prNumber: 5 });
}

function mkWorkspaceHarness(projectDir: string, names = ["api", "web"]): StackHarness {
  const h = mkStackHarness(projectDir);
  const repos = names.map((name) => ({
    name,
    path: join(projectDir, name),
    owner: "acme",
    repo: name,
    baseBranch: name === "web" ? "origin/develop" : "origin/main",
    buildCommand: "build",
    testCommand: "test",
    modules: [],
  }));
  h.pipelineState = new PipelineStateStore(db, names);
  h.io = {
    ...h.io,
    config: makeTestConfig({ project: { directory: projectDir, repos } }),
    pipelineState: h.pipelineState,
  };
  return h;
}

// Records every git invocation; per-prefix overrides supply output or throw.
function fakeGit(overrides: [string, string | (() => string)][] = []): {
  run: GitRun;
  calls: string[];
} {
  const calls: string[] = [];
  const run: GitRun = (args) => {
    const cmd = args.join(" ");
    calls.push(cmd);
    for (const [prefix, out] of overrides) {
      if (cmd.startsWith(prefix)) {
        return typeof out === "function" ? out() : out;
      }
    }
    if (cmd.startsWith("rev-parse")) {
      throw new Error("unknown ref");
    }
    return "";
  };
  return { run, calls };
}

function realGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

describe("executeStackSetup (fake git)", () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rq-stack-cli-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fresh: branches from base and merges ancestors in order", async () => {
    const h = mkStackHarness(tmp);
    satisfyBlockerAtGate(h, "#1", "feature/#1");
    const git = fakeGit();

    const result = await executeStackSetup({ ...h.io, git: git.run });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(result.branch).toBe("feature/#2");
    expect(result.merged).toEqual(["origin/feature/#1"]);
    expect(result.prBase).toBe("feature/#1");
    expect(git.calls).toEqual([
      "ls-remote --heads origin refs/heads/feature/#2",
      "fetch origin +refs/heads/main:refs/remotes/origin/main +refs/heads/feature/#1:refs/remotes/origin/feature/#1",
      "rev-parse --verify --quiet refs/heads/feature/#2",
      `worktree add -b feature/#2 ${result.worktree} origin/main`,
      "merge --no-edit origin/feature/#1",
    ]);
    const record = h.pipelineState.get("#2");
    expect(record?.branchName).toBe("feature/#2");
    expect(record?.worktreePath).toBe(result.worktree);
  });

  it("reuse (stacked): no worktree add, no rebase, no base merge — syncs own remote branch then ancestors", async () => {
    const h = mkStackHarness(tmp);
    satisfyBlockerAtGate(h, "#1", "feature/#1");
    h.pipelineState.create("#2", "coding");
    h.pipelineState.updateBranchInfo("#2", "app", { branchName: "feature/#2" });
    mkdirSync(join(tmp, ".redqueen", "worktrees", "#2"), { recursive: true });
    const git = fakeGit([["ls-remote", "sha\trefs/heads/feature/#2\n"]]);

    const result = await executeStackSetup({ ...h.io, git: git.run });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    // No origin/main merge while the PR targets the blocker's branch — newer
    // base commits would land in the PR diff.
    expect(git.calls).toEqual([
      "ls-remote --heads origin refs/heads/feature/#2",
      "fetch origin +refs/heads/main:refs/remotes/origin/main +refs/heads/feature/#2:refs/remotes/origin/feature/#2 +refs/heads/feature/#1:refs/remotes/origin/feature/#1",
      "merge --no-edit origin/feature/#2",
      "merge --no-edit origin/feature/#1",
    ]);
    expect(git.calls.some((c) => c.includes("rebase"))).toBe(false);
    expect(result.merged).toEqual(["origin/feature/#2", "origin/feature/#1"]);
  });

  it("reuse (unstacked): merges base after own remote branch", async () => {
    const h = mkStackHarness(tmp);
    h.pipelineState.create("#2", "coding");
    h.pipelineState.updateBranchInfo("#2", "app", { branchName: "feature/#2" });
    mkdirSync(join(tmp, ".redqueen", "worktrees", "#2"), { recursive: true });
    const git = fakeGit([["ls-remote", "sha\trefs/heads/feature/#2\n"]]);

    const result = await executeStackSetup({ ...h.io, git: git.run });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(git.calls).toEqual([
      "ls-remote --heads origin refs/heads/feature/#2",
      "fetch origin +refs/heads/main:refs/remotes/origin/main +refs/heads/feature/#2:refs/remotes/origin/feature/#2",
      "merge --no-edit origin/feature/#2",
      "merge --no-edit origin/main",
    ]);
    expect(result.merged).toEqual(["origin/feature/#2", "origin/main"]);
  });

  it("spec: detached throwaway worktree, no branch, no pipeline write", async () => {
    const h = mkStackHarness(tmp);
    satisfyBlockerAtGate(h, "#1", "feature/#1");
    const git = fakeGit();

    const result = await executeStackSetup({ ...h.io, spec: true, git: git.run });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(result.branch).toBeNull();
    expect(result.worktree).toBe(join(tmp, ".redqueen", "worktrees", "spec-#2"));
    expect(git.calls).toEqual([
      "fetch origin +refs/heads/main:refs/remotes/origin/main +refs/heads/feature/#1:refs/remotes/origin/feature/#1",
      `worktree add --detach ${result.worktree} origin/main`,
      "merge --no-edit origin/feature/#1",
    ]);
    expect(h.pipelineState.get("#2")).toBeNull();
  });

  it("conflict: reports unmerged files and leaves the merge in place", async () => {
    const h = mkStackHarness(tmp);
    satisfyBlockerAtGate(h, "#1", "feature/#1");
    const git = fakeGit([
      [
        "merge",
        () => {
          throw new Error("merge conflict");
        },
      ],
      ["diff --name-only", "src/a.ts\nsrc/b.ts\n"],
    ]);

    const result = await executeStackSetup({ ...h.io, git: git.run });

    expect(result).toEqual({
      status: "conflict",
      repo: "app",
      branch: "feature/#2",
      files: ["src/a.ts", "src/b.ts"],
      repos: [],
    });
    expect(git.calls.some((c) => c.startsWith("merge --abort"))).toBe(false);
  });

  it("spec conflict: aborts the in-progress merge so the worktree stays explorable", async () => {
    const h = mkStackHarness(tmp);
    satisfyBlockerAtGate(h, "#1", "feature/#1");
    const git = fakeGit([
      [
        "merge --no-edit",
        () => {
          throw new Error("merge conflict");
        },
      ],
      ["diff --name-only", "src/a.ts\n"],
    ]);

    const result = await executeStackSetup({ ...h.io, spec: true, git: git.run });

    expect(result).toEqual({
      status: "conflict",
      repo: "app",
      branch: null,
      files: ["src/a.ts"],
      repos: [],
    });
    expect(git.calls).toContain("merge --abort");
  });

  it("merge failure without unmerged files rethrows instead of reporting an empty conflict", async () => {
    const h = mkStackHarness(tmp);
    satisfyBlockerAtGate(h, "#1", "feature/#1");
    const git = fakeGit([
      [
        "merge",
        () => {
          throw new Error("spawn git EAGAIN");
        },
      ],
    ]);

    await expect(executeStackSetup({ ...h.io, git: git.run })).rejects.toThrow("spawn git EAGAIN");
  });

  it("blocked: unsatisfied blocker short-circuits before any git call", async () => {
    const h = mkStackHarness(tmp);
    h.issueTracker.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.issueTracker.phases.set("#1", "coding");
    const git = fakeGit();

    const result = await executeStackSetup({ ...h.io, git: git.run });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      return;
    }
    expect(result.unsatisfied).toEqual(["#1"]);
    expect(git.calls).toEqual([]);
  });

  it("workspace: uses each scoped repo's path, base and ancestors", async () => {
    const h = mkWorkspaceHarness(tmp);
    h.pipelineState.create("#2", "coding");
    h.pipelineState.setScope("#2", ["api", "web"]);
    h.issueTracker.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.issueTracker.phases.set("#1", "human-review");
    h.pipelineState.create("#1", "human-review");
    h.pipelineState.updateBranchInfo("#1", "api", { branchName: "feature/#1", prNumber: 5 });
    const git = fakeGit();
    const calls: { cmd: string; cwd: string }[] = [];

    const result = await executeStackSetup({
      ...h.io,
      git: (args, cwd) => {
        calls.push({ cmd: args.join(" "), cwd });
        return git.run(args, cwd);
      },
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(result.repos).toEqual([
      {
        repo: "api",
        worktree: join(tmp, ".redqueen", "worktrees", "#2", "api"),
        branch: "feature/#2",
        merged: ["origin/feature/#1"],
        prBase: "feature/#1",
      },
      {
        repo: "web",
        worktree: join(tmp, ".redqueen", "worktrees", "#2", "web"),
        branch: "feature/#2",
        merged: [],
        prBase: "develop",
      },
    ]);
    expect(result.worktree).toBe(result.repos[0]?.worktree);
    expect(result.branch).toBe(result.repos[0]?.branch);
    expect(result.merged).toEqual(result.repos[0]?.merged);
    expect(result.prBase).toBe(result.repos[0]?.prBase);
    expect(calls.filter((call) => call.cmd.startsWith("fetch")).map((call) => call.cwd)).toEqual([
      join(tmp, "api"),
      join(tmp, "web"),
    ]);
    expect(calls.some((call) => call.cwd === tmp)).toBe(false);
    expect(git.calls).toContain("fetch origin +refs/heads/develop:refs/remotes/origin/develop");
    expect(h.pipelineState.getRepo("#2", "web")).toMatchObject({
      branchName: "feature/#2",
      worktreePath: result.repos[1]?.worktree,
    });
  });

  it("workspace: preserves each selected row's existing branch name", async () => {
    const h = mkWorkspaceHarness(tmp);
    h.pipelineState.create("#2", "coding");
    h.pipelineState.updateBranchInfo("#2", "api", { branchName: "custom/api" });
    h.pipelineState.updateBranchInfo("#2", "web", { branchName: "custom/web" });
    const result = await executeStackSetup({ ...h.io, git: fakeGit().run });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.repos.map((repo) => repo.branch)).toEqual(["custom/api", "custom/web"]);
    }
    expect(h.pipelineState.getRepo("#2", "api")?.branchName).toBe("custom/api");
    expect(h.pipelineState.getRepo("#2", "web")?.branchName).toBe("custom/web");
  });

  it("workspace: ignores a descoped branch when naming a new scoped branch", async () => {
    const h = mkWorkspaceHarness(tmp);
    h.pipelineState.create("#2", "coding");
    h.pipelineState.updateBranchInfo("#2", "api", { branchName: "orphan/api" });
    h.pipelineState.setScope("#2", ["web"]);
    const original = h.pipelineState.getRepo("#2", "api");
    const git = fakeGit();
    const result = await executeStackSetup({ ...h.io, git: git.run });
    expect(result).toMatchObject({ status: "ok", branch: "feature/#2", prBase: "develop" });
    expect(git.calls.some((call) => call.includes("orphan/api"))).toBe(false);
    expect(h.pipelineState.getRepo("#2", "api")).toEqual(original);
  });

  it("workspace: skips completed rows during rework while starting unfinished siblings", async () => {
    const h = mkWorkspaceHarness(tmp);
    h.pipelineState.create("#2", "human-review");
    h.pipelineState.setScope("#2", ["api", "web"]);
    h.pipelineState.updateBranchInfo("#2", "api", { branchName: "feature/api", prNumber: 5 });
    h.pipelineState.markPrMerged("#2", "api", 5);
    h.pipelineState.updateBranchInfo("#2", "api", { branchName: null, worktreePath: null });
    h.pipelineState.updatePhase("#2", "code-feedback");
    const original = h.pipelineState.getRepo("#2", "api");
    const result = await executeStackSetup({ ...h.io, git: fakeGit().run });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.repos.map((repo) => repo.repo)).toEqual(["web"]);
    }
    expect(h.pipelineState.getRepo("#2", "api")).toEqual(original);
  });

  it.each([false, true])(
    "workspace: rejects empty scope without mutations, existing=%s",
    async (existing) => {
      const h = mkWorkspaceHarness(tmp, ["api"]);
      if (existing) {
        h.pipelineState.create("#2", "coding");
      }
      const original = h.pipelineState.get("#2");
      const git = fakeGit();
      await expect(executeStackSetup({ ...h.io, git: git.run })).rejects.toThrow(
        /no .*scope.*spec meta.*--repos/i,
      );
      expect(git.calls).toEqual([]);
      expect(h.pipelineState.get("#2")).toEqual(original);
    },
  );

  it("workspace: completed-only scope does not recreate a worktree", async () => {
    const h = mkWorkspaceHarness(tmp);
    h.pipelineState.create("#2", "human-review");
    h.pipelineState.updateBranchInfo("#2", "web", { branchName: "feature/web", prNumber: 5 });
    h.pipelineState.markPrMerged("#2", "web", 5);
    const original = h.pipelineState.get("#2");
    const git = fakeGit();
    await expect(executeStackSetup({ ...h.io, git: git.run })).rejects.toThrow(
      /no unfinished.*repositories/i,
    );
    expect(git.calls).toEqual([]);
    expect(h.pipelineState.get("#2")).toEqual(original);
  });

  it("workspace --spec: explores every repo without changing completed scope", async () => {
    const h = mkWorkspaceHarness(tmp);
    h.pipelineState.create("#2", "human-review");
    h.pipelineState.updateBranchInfo("#2", "api", { branchName: "feature/api", prNumber: 5 });
    h.pipelineState.markPrMerged("#2", "api", 5);
    const original = h.pipelineState.get("#2");
    const git = fakeGit();
    const result = await executeStackSetup({ ...h.io, spec: true, git: git.run });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.repos.map((repo) => [repo.repo, repo.branch, repo.worktree])).toEqual([
        ["api", null, join(tmp, ".redqueen", "worktrees", "spec-#2", "api")],
        ["web", null, join(tmp, ".redqueen", "worktrees", "spec-#2", "web")],
      ]);
    }
    expect(git.calls).toContain(
      `worktree add --detach ${join(tmp, ".redqueen", "worktrees", "spec-#2", "web")} origin/develop`,
    );
    expect(h.pipelineState.get("#2")).toEqual(original);
  });

  it("workspace: conflict identifies its repo and returns earlier completed setups", async () => {
    const h = mkWorkspaceHarness(tmp);
    h.pipelineState.create("#2", "coding");
    h.pipelineState.setScope("#2", ["api", "web"]);
    h.issueTracker.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.issueTracker.phases.set("#1", "human-review");
    h.pipelineState.create("#1", "human-review");
    h.pipelineState.updateBranchInfo("#1", "api", { branchName: "feature/api", prNumber: 5 });
    h.pipelineState.updateBranchInfo("#1", "web", { branchName: "feature/web", prNumber: 6 });
    const git = fakeGit([
      [
        "merge --no-edit origin/feature/web",
        () => {
          throw new Error("conflict");
        },
      ],
      ["diff --name-only --diff-filter=U", "src/web.ts\n"],
    ]);
    const result = await executeStackSetup({ ...h.io, git: git.run });
    expect(result).toMatchObject({ status: "conflict", repo: "web", files: ["src/web.ts"] });
    if (result.status === "conflict") {
      expect(result.repos.map((repo) => repo.repo)).toEqual(["api"]);
    }
  });
});

describe("executeStackSetup (real git)", () => {
  let remote: string;
  let project: string;

  function commitFile(cwd: string, file: string, content: string, message: string): void {
    writeFileSync(join(cwd, file), content);
    realGit(["add", file], cwd);
    realGit(["commit", "-q", "-m", message], cwd);
  }

  // The clone needs its own identity — CI runners have no global git config,
  // and a non-fast-forward merge in the worktree dies without one.
  function cloneProject(): void {
    realGit(["clone", "-q", remote, project], tmp);
    realGit(["config", "user.email", "t@example.com"], project);
    realGit(["config", "user.name", "T"], project);
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rq-stack-git-"));
    remote = join(tmp, "remote");
    project = join(tmp, "project");
    mkdirSync(remote);
    realGit(["init", "-q", "-b", "main"], remote);
    realGit(["config", "user.email", "t@example.com"], remote);
    realGit(["config", "user.name", "T"], remote);
    commitFile(remote, "base.txt", "base\n", "base");
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("assembles the stack for real and re-runs idempotently", async () => {
    realGit(["checkout", "-q", "-b", "feature/#1"], remote);
    commitFile(remote, "blocker.txt", "from blocker\n", "blocker work");
    realGit(["checkout", "-q", "main"], remote);
    cloneProject();

    const h = mkStackHarness(project);
    satisfyBlockerAtGate(h, "#1", "feature/#1");

    const first = await executeStackSetup({ ...h.io, git: realGit });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") {
      return;
    }
    expect(existsSync(join(first.worktree, "blocker.txt"))).toBe(true);
    expect(realGit(["branch", "--show-current"], first.worktree).trim()).toBe("feature/#2");
    expect(first.prBase).toBe("feature/#1");

    // Idempotent re-run: reuse path, merges report "Already up to date".
    const second = await executeStackSetup({ ...h.io, git: realGit });
    expect(second.status).toBe("ok");
  });

  it("reports a real merge conflict with the conflicted files", async () => {
    commitFile(remote, "file.txt", "one\n", "seed");
    realGit(["checkout", "-q", "-b", "feature/#1"], remote);
    commitFile(remote, "file.txt", "blocker line\n", "blocker change");
    realGit(["checkout", "-q", "main"], remote);
    commitFile(remote, "file.txt", "mainline\n", "main change");
    cloneProject();

    const h = mkStackHarness(project);
    satisfyBlockerAtGate(h, "#1", "feature/#1");

    const result = await executeStackSetup({ ...h.io, git: realGit });

    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") {
      return;
    }
    expect(result.files).toEqual(["file.txt"]);
    expect(result.branch).toBe("feature/#2");
  });
});
