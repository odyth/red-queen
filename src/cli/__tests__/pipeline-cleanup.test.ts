import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { makeTestConfig } from "../../core/__tests__/fixtures/test-config.js";
import type { AuditLogger } from "../../core/audit.js";
import {
  MockIssueTracker,
  MockSourceControl,
} from "../../core/__tests__/fixtures/mock-adapters.js";
import { RedQueenDatabase } from "../../core/database.js";
import { PipelineStateStore } from "../../core/pipeline-state.js";
import { SubIterationStore } from "../../core/sub-iteration.js";
import { createSourceControlRegistry } from "../../integrations/source-control-registry.js";
import { loadCliContext } from "../context.js";
import type { CliContext } from "../context.js";
import { cmdPipeline } from "../pipeline.js";

vi.mock("../context.js", () => ({ loadCliContext: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(),
}));

let database: RedQueenDatabase;
let ctx: CliContext;
let stdoutCapture: string[];
const auditLog = vi.fn<AuditLogger["log"]>();

beforeEach(() => {
  vi.clearAllMocks();
  database = new RedQueenDatabase(":memory:");
  const repos = ["api", "web"].map((name) => ({
    name,
    path: `/workspace/${name}`,
    owner: "acme",
    repo: name,
    baseBranch: "origin/main",
    buildCommand: "build",
    testCommand: "test",
    modules: [],
  }));
  ctx = {
    config: makeTestConfig({ project: { directory: "/workspace", repos } }),
    configPath: "/workspace/redqueen.yaml",
    projectRoot: "/workspace",
    issueTracker: new MockIssueTracker(),
    sourceControls: createSourceControlRegistry(
      repos.map((repo) => ({
        name: repo.name,
        fullName: `acme/${repo.name}`,
        adapter: new MockSourceControl(),
      })),
    ),
    pipelineState: new PipelineStateStore(database.db, ["api", "web"]),
    subIteration: new SubIterationStore(database.db),
    audit: { log: auditLog, query: () => [], prune: () => 0 },
    cleanup: vi.fn(),
  };
  vi.mocked(loadCliContext).mockReturnValue(ctx);
  vi.mocked(execFileSync).mockReturnValue(Buffer.alloc(0));
  vi.mocked(existsSync).mockReturnValue(true);
  stdoutCapture = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutCapture.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  ctx.pipelineState.create("ISSUE-1", "human-review");
  for (const repo of repos) {
    ctx.pipelineState.updateBranchInfo("ISSUE-1", repo.name, {
      branchName: `feature/${repo.name}`,
      worktreePath: `/worktrees/ISSUE-1/${repo.name}`,
    });
  }
});

afterEach(() => {
  database.close();
  vi.restoreAllMocks();
});

function output(): unknown {
  return JSON.parse(stdoutCapture.at(-1) ?? "null") as unknown;
}

describe("pipeline cleanup across repositories", () => {
  it("cleans each repo at its own path, including descoped administrative orphans", async () => {
    ctx.pipelineState.setScope("ISSUE-1", ["web"]);

    await cmdPipeline(["cleanup", "ISSUE-1"]);

    expect(execFileSync).toHaveBeenCalledTimes(4);
    for (const repo of ["api", "web"]) {
      expect(execFileSync).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", "--force", "--", `/worktrees/ISSUE-1/${repo}`],
        { cwd: `/workspace/${repo}`, stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(execFileSync).toHaveBeenCalledWith("git", ["branch", "-D", "--", `feature/${repo}`], {
        cwd: `/workspace/${repo}`,
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(ctx.pipelineState.getRepo("ISSUE-1", repo)).toMatchObject({
        branchName: null,
        worktreePath: null,
        inScope: repo === "web",
      });
    }
    expect(output()).toEqual({
      ok: true,
      removed: ["/worktrees/ISSUE-1/api", "/worktrees/ISSUE-1/web"],
      branchDeleted: ["api:feature/api", "web:feature/web"],
    });
    expect(ctx.cleanup).toHaveBeenCalledOnce();
  });

  it("keep-branch clears every worktree while retaining local branch identities", async () => {
    await cmdPipeline(["cleanup", "ISSUE-1", "--keep-branch"]);

    expect(execFileSync).toHaveBeenCalledTimes(2);
    for (const repo of ["api", "web"]) {
      expect(ctx.pipelineState.getRepo("ISSUE-1", repo)).toMatchObject({
        branchName: `feature/${repo}`,
        worktreePath: null,
      });
    }
    expect(output()).toMatchObject({ branchDeleted: [] });
  });

  it("retains worktree and branch after a removal failure, then succeeds on retry", async () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("worktree is locked");
    });

    await cmdPipeline(["cleanup", "ISSUE-1"]);

    expect(execFileSync).toHaveBeenCalledTimes(3);
    expect(ctx.pipelineState.getRepo("ISSUE-1", "api")).toMatchObject({
      branchName: "feature/api",
      worktreePath: "/worktrees/ISSUE-1/api",
    });
    expect(ctx.pipelineState.getRepo("ISSUE-1", "web")).toMatchObject({
      branchName: null,
      worktreePath: null,
    });
    expect(auditLog.mock.calls[0]?.[0]).toMatchObject({
      metadata: { repo: "api", worktreePath: "/worktrees/ISSUE-1/api" },
    });
    expect(auditLog.mock.calls[0]?.[0].message).toContain("worktree is locked");
    expect(output()).toMatchObject({ branchDeleted: ["web:feature/web"] });

    vi.mocked(execFileSync).mockClear();
    await cmdPipeline(["cleanup", "ISSUE-1"]);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(ctx.pipelineState.getRepo("ISSUE-1", "api")).toMatchObject({
      branchName: null,
      worktreePath: null,
    });
    expect(output()).toMatchObject({ branchDeleted: ["api:feature/api"] });
  });

  it("retains a branch that still exists after deletion fails, then retries it", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("branch is checked out elsewhere");
    });

    await cmdPipeline(["cleanup", "ISSUE-1"]);

    expect(ctx.pipelineState.getRepo("ISSUE-1", "api")).toMatchObject({
      branchName: "feature/api",
      worktreePath: null,
    });
    expect(output()).toMatchObject({ removed: [], branchDeleted: ["web:feature/web"] });
    vi.mocked(execFileSync).mockClear();
    await cmdPipeline(["cleanup", "ISSUE-1"]);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(ctx.pipelineState.getRepo("ISSUE-1", "api")?.branchName).toBeNull();
  });

  it.each([
    { lookupError: { status: 1 }, branchAbsent: true, label: "missing ref" },
    { lookupError: { status: 128 }, branchAbsent: false, label: "invalid repository" },
    { lookupError: { code: "ENOENT" }, branchAbsent: false, label: "spawn failure" },
    { lookupError: { code: 1 }, branchAbsent: false, label: "non-exit error code" },
  ])(
    "distinguishes a missing branch from $label on retry",
    async ({ lookupError, branchAbsent }) => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(execFileSync)
        .mockImplementationOnce(() => {
          throw new Error("branch deletion failed");
        })
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("show-ref failed"), lookupError);
        });

      await cmdPipeline(["cleanup", "ISSUE-1"]);

      expect(ctx.pipelineState.getRepo("ISSUE-1", "api")).toMatchObject({
        branchName: branchAbsent ? null : "feature/api",
        worktreePath: null,
      });
      expect(output()).toEqual({ ok: true, removed: [], branchDeleted: ["web:feature/web"] });
    },
  );

  it("retains completed merge evidence when clearing artifacts", async () => {
    ctx.pipelineState.updateBranchInfo("ISSUE-1", "api", { prNumber: 5 });
    ctx.pipelineState.markPrMerged("ISSUE-1", "api", 5);

    await cmdPipeline(["cleanup", "ISSUE-1"]);

    expect(ctx.pipelineState.getRepo("ISSUE-1", "api")).toMatchObject({
      branchName: null,
      worktreePath: null,
      mergeCompleted: true,
      terminalPrNumber: 5,
    });
  });
});
