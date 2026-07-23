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
  const pipelineState = new PipelineStateStore(db);
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
  h.pipelineState.updateBranchInfo(id, { branchName: branch, prNumber: 5 });
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
    h.pipelineState.updateBranchInfo("#2", { branchName: "feature/#2" });
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
    h.pipelineState.updateBranchInfo("#2", { branchName: "feature/#2" });
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
      branch: "feature/#2",
      files: ["src/a.ts", "src/b.ts"],
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

    expect(result).toEqual({ status: "conflict", branch: null, files: ["src/a.ts"] });
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
