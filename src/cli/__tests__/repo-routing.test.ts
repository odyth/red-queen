import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MockIssueTracker,
  MockSourceControl,
} from "../../core/__tests__/fixtures/mock-adapters.js";
import { makeTestConfig } from "../../core/__tests__/fixtures/test-config.js";
import type { AuditLogger } from "../../core/audit.js";
import type { RepoConfig } from "../../core/config.js";
import { RedQueenDatabase } from "../../core/database.js";
import { PipelineStateStore } from "../../core/pipeline-state.js";
import { SubIterationStore } from "../../core/sub-iteration.js";
import { createSourceControlRegistry } from "../../integrations/source-control-registry.js";
import type { SourceControl } from "../../integrations/source-control.js";
import { loadCliContext } from "../context.js";
import type { CliContext } from "../context.js";
import { cmdPipeline } from "../pipeline.js";
import { cmdPr } from "../pr.js";

vi.mock("../context.js", () => ({ loadCliContext: vi.fn() }));

function repo(name: string): RepoConfig {
  return {
    name,
    path: `/srv/${name}`,
    owner: "acme",
    repo: name,
    baseBranch: "origin/main",
    buildCommand: "build",
    testCommand: "test",
    modules: [],
  };
}

const createArgs = [
  "create",
  "--issue",
  "ISSUE-1",
  "--head",
  "feature/web",
  "--base",
  "main",
  "--title",
  "Web change",
  "--body",
  "Description",
  "--draft",
];
const routes: {
  label: string;
  args: string[];
  method: keyof SourceControl;
  expected: unknown[];
}[] = [
  {
    label: "create",
    args: createArgs,
    method: "createPullRequest",
    expected: [
      { title: "Web change", body: "Description", head: "feature/web", base: "main", draft: true },
    ],
  },
  { label: "diff", args: ["diff", "1"], method: "getPullRequestDiff", expected: [1] },
  { label: "checks", args: ["checks", "1"], method: "getChecks", expected: [1] },
  {
    label: "checks wait",
    args: ["checks", "1", "--wait", "1"],
    method: "getChecks",
    expected: [1],
  },
  {
    label: "review",
    args: ["review", "1", "--verdict", "approve", "--body", "LGTM"],
    method: "postReview",
    expected: [1, "LGTM", "approve"],
  },
  { label: "reviews", args: ["reviews", "1"], method: "getReviews", expected: [1] },
  {
    label: "reviews latest",
    args: ["reviews", "1", "--latest"],
    method: "getReviews",
    expected: [1],
  },
  {
    label: "comments",
    args: ["comments", "1"],
    method: "getReviewThreads",
    expected: [1, { unresolvedOnly: true }],
  },
  {
    label: "comments threads",
    args: ["comments", "1", "--threads", "--include-resolved"],
    method: "getReviewThreads",
    expected: [1, { unresolvedOnly: false }],
  },
  {
    label: "comment",
    args: ["comment", "1", "--body", "Updated"],
    method: "postPrComment",
    expected: [1, "Updated"],
  },
  {
    label: "reply",
    args: ["reply", "1", "42", "--body", "Fixed"],
    method: "replyToComment",
    expected: [1, 42, "Fixed"],
  },
];

let database: RedQueenDatabase;
let ctx: CliContext;
let api: MockSourceControl;
let web: MockSourceControl;
const auditLog = vi.fn<AuditLogger["log"]>();

beforeEach(() => {
  auditLog.mockClear();
  database = new RedQueenDatabase(":memory:");
  api = new MockSourceControl();
  web = new MockSourceControl();
  ctx = {
    config: makeTestConfig({ project: { repos: [repo("api"), repo("web")] } }),
    configPath: "/srv/redqueen.yaml",
    projectRoot: "/srv",
    issueTracker: new MockIssueTracker(),
    sourceControls: createSourceControlRegistry([
      { name: "api", fullName: "acme/api", adapter: api },
      { name: "web", fullName: "acme/web", adapter: web },
    ]),
    pipelineState: new PipelineStateStore(database.db, ["api", "web"]),
    subIteration: new SubIterationStore(database.db),
    audit: { log: auditLog, query: () => [], prune: () => 0 },
    cleanup: vi.fn(),
  };
  vi.mocked(loadCliContext).mockReturnValue(ctx);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});

afterEach(() => {
  database.close();
  vi.restoreAllMocks();
});

describe("PR repository routing", () => {
  it.each(routes)("$label targets the selected adapter", async ({ args, method, expected }) => {
    const primaryCall = vi.spyOn(api, method);
    const selectedCall = vi.spyOn(web, method);
    await cmdPr([...args, "--repo", "web"]);
    expect(selectedCall).toHaveBeenCalledExactlyOnceWith(...expected);
    expect(primaryCall).not.toHaveBeenCalled();
    expect(ctx.cleanup).toHaveBeenCalledOnce();
  });

  it.each(routes)("$label defaults to the legacy repo", async ({ args, method, expected }) => {
    ctx.config = makeTestConfig();
    ctx.sourceControls = createSourceControlRegistry([
      { name: "app", fullName: "acme/app", adapter: api },
    ]);
    ctx.pipelineState = new PipelineStateStore(database.db, ["app"]);
    const call = vi.spyOn(api, method);
    await cmdPr(args);
    expect(call).toHaveBeenCalledExactlyOnceWith(...expected);
  });

  it.each(routes)("$label rejects missing or unknown repos before acting", async ({ args }) => {
    const getAdapter = vi.spyOn(ctx.sourceControls, "get");
    const createRecord = vi.spyOn(ctx.pipelineState, "create");
    for (const repos of [[repo("web")], [repo("api"), repo("web")]]) {
      ctx.config = makeTestConfig({ project: { repos } });
      await expect(cmdPr(args)).rejects.toThrow(/--repo <name> is required.*web/);
      await expect(cmdPr([...args, "--repo", "missing"])).rejects.toThrow(
        /unknown repo "missing".*web/,
      );
    }
    expect(getAdapter).not.toHaveBeenCalled();
    expect(createRecord).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
    expect(ctx.cleanup).toHaveBeenCalledTimes(4);
  });

  it("create stores colliding PR numbers on separate rows and audits the selected repo", async () => {
    ctx.pipelineState.create("ISSUE-1");
    ctx.pipelineState.updateBranchInfo("ISSUE-1", "api", {
      branchName: "feature/api",
      prNumber: 1,
      prBaseBranch: "develop",
      worktreePath: "/work/api",
    });
    const original = ctx.pipelineState.getRepo("ISSUE-1", "api");
    await cmdPr([...createArgs, "--repo", "web"]);
    expect(ctx.pipelineState.getRepo("ISSUE-1", "api")).toEqual(original);
    expect(ctx.pipelineState.getRepo("ISSUE-1", "web")).toMatchObject({
      branchName: "feature/web",
      prNumber: 1,
      prBaseBranch: "main",
    });
    expect(ctx.pipelineState.get("ISSUE-1")).toMatchObject({
      branchName: "feature/api",
      prNumber: 1,
      prBaseBranch: "develop",
      worktreePath: "/work/api",
    });
    expect(auditLog.mock.calls.at(-1)?.[0].metadata).toMatchObject({ repo: "web", prNumber: 1 });
  });

  it("releases the context if the selected adapter fails", async () => {
    vi.spyOn(web, "getPullRequestDiff").mockRejectedValue(new Error("diff failed"));
    await expect(cmdPr(["diff", "1", "--repo", "web"])).rejects.toThrow("diff failed");
    expect(ctx.cleanup).toHaveBeenCalledOnce();
  });
});

describe("pipeline update repository routing", () => {
  it("applies branch, PR, worktree and clear flags only to the selected row", async () => {
    ctx.pipelineState.create("ISSUE-1");
    for (const name of ["api", "web"]) {
      ctx.pipelineState.updateBranchInfo("ISSUE-1", name, {
        branchName: `feature/${name}`,
        prNumber: 1,
        prBaseBranch: "develop",
        worktreePath: `/work/${name}`,
      });
    }
    const original = ctx.pipelineState.getRepo("ISSUE-1", "api");
    await cmdPipeline([
      "update",
      "ISSUE-1",
      "--repo",
      "web",
      "--branch",
      "feature/new",
      "--pr",
      "2",
      "--worktree",
      "/work/new",
      "--pretty",
    ]);
    expect(ctx.pipelineState.getRepo("ISSUE-1", "api")).toEqual(original);
    expect(ctx.pipelineState.getRepo("ISSUE-1", "web")).toMatchObject({
      branchName: "feature/new",
      prNumber: 2,
      prBaseBranch: null,
      worktreePath: "/work/new",
    });
    await cmdPipeline(["update", "ISSUE-1", "--repo", "web", "--clear-pr", "--clear-worktree"]);
    expect(ctx.pipelineState.getRepo("ISSUE-1", "api")).toEqual(original);
    expect(ctx.pipelineState.getRepo("ISSUE-1", "web")).toMatchObject({
      branchName: "feature/new",
      prNumber: null,
      prBaseBranch: null,
      worktreePath: null,
    });
    expect(ctx.pipelineState.get("ISSUE-1")).toMatchObject({
      branchName: "feature/api",
      prNumber: 1,
      prBaseBranch: "develop",
      worktreePath: "/work/api",
    });
    expect(auditLog.mock.calls.at(-1)?.[0].metadata).toEqual({
      repo: "web",
      prNumber: null,
      prBaseBranch: null,
      worktreePath: null,
    });
  });

  it("requires a repo even for a one-repo workspace and leaves state untouched", async () => {
    ctx.config = makeTestConfig({ project: { repos: [repo("web")] } });
    await expect(cmdPipeline(["update", "ISSUE-1", "--branch", "new"])).rejects.toThrow(
      /--repo <name> is required.*web/,
    );
    await expect(
      cmdPipeline(["update", "ISSUE-1", "--repo", "missing", "--pr", "1"]),
    ).rejects.toThrow(/unknown repo "missing".*web/);
    expect(ctx.pipelineState.get("ISSUE-1")).toBeNull();
    expect(auditLog).not.toHaveBeenCalled();
    expect(ctx.cleanup).toHaveBeenCalledTimes(2);
  });
});
