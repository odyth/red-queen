import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildPhaseGraph } from "../core/config.js";
import type { RedQueenConfig } from "../core/config.js";
import type { PipelineStateStore } from "../core/pipeline-state.js";
import { resolveBranchPrefix } from "../core/skill-context.js";
import { bareBaseBranch, resolveStack, terminalGateNames } from "../core/stack.js";
import type { StackProblem } from "../core/stack.js";
import type { IssueTracker } from "../integrations/issue-tracker.js";
import { loadCliContext } from "./context.js";
import { CliError } from "./errors.js";
import { writeJson } from "./io.js";

// Deterministic stacked-branch assembly: branch from base, merge unmerged
// ancestor branches in topo order. Merge-based on purpose — never rebase a
// stacked worktree (history rewrites break every dependent downstream).

export type GitRun = (args: string[], cwd: string) => string;

export interface StackSetupIo {
  issueId: string;
  spec: boolean;
  config: RedQueenConfig;
  issueTracker: IssueTracker;
  pipelineState: PipelineStateStore;
  git: GitRun;
}

export type StackSetupOutput =
  | {
      status: "ok";
      worktree: string;
      branch: string | null;
      merged: string[];
      prBase: string;
    }
  | {
      status: "blocked";
      unsatisfied: string[];
      problems: StackProblem[];
      cycle: string[] | null;
    }
  | { status: "conflict"; branch: string | null; files: string[] };

export async function executeStackSetup(io: StackSetupIo): Promise<StackSetupOutput> {
  const { issueId, spec, config, issueTracker, pipelineState, git } = io;
  const projectDir = config.project.directory;
  const bareBase = bareBaseBranch(config.pipeline.baseBranch);

  const resolution = await resolveStack(issueId, bareBase, {
    getBlockedBy: (id) => issueTracker.getBlockedBy(id),
    getPipelineRecord: (id) => pipelineState.get(id),
    getTrackerPhase: (id) => issueTracker.getPhase(id),
    terminalGates: terminalGateNames(buildPhaseGraph(config.phases)),
  });
  if (resolution.ok === false) {
    // Belt-and-braces — the orchestrator already gated before dispatch.
    return {
      status: "blocked",
      unsatisfied: resolution.unsatisfied,
      problems: resolution.problems,
      cycle: resolution.cycle,
    };
  }

  const worktreePath = join(
    projectDir,
    ".redqueen",
    "worktrees",
    spec ? `spec-${issueId}` : issueId,
  );
  const reuse = existsSync(worktreePath);

  let branch: string | null = null;
  let remoteBranchExists = false;
  if (spec === false) {
    const record = pipelineState.get(issueId);
    branch = record?.branchName ?? null;
    if (branch === null) {
      const issueType = await issueTracker.getIssue(issueId).then(
        (issue) => issue.issueType,
        () => null,
      );
      branch = resolveBranchPrefix(config.pipeline.branchPrefixes, issueType) + issueId;
    }
    // refs/heads/ prefix, same as the webhook path: never let a branch name
    // parse as a git option.
    remoteBranchExists =
      git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], projectDir).trim() !== "";
  }

  const fetchRefs = [
    ...new Set([
      bareBase,
      ...(remoteBranchExists && branch !== null ? [branch] : []),
      ...resolution.mergeBranches,
    ]),
  ];
  // Explicit destination refspecs: opportunistic origin/<X> tracking updates
  // follow the clone's fetch config, which --single-branch narrows — without
  // a destination the origin/<X> refs below would never materialize there.
  // The + keeps force-pushed ancestor branches from failing the fetch.
  git(
    ["fetch", "origin", ...fetchRefs.map((r) => `+refs/heads/${r}:refs/remotes/origin/${r}`)],
    projectDir,
  );

  if (spec) {
    if (reuse) {
      // Throwaway exploration worktree — make re-runs deterministic by
      // re-detaching onto the fresh base tip.
      git(["checkout", "--detach", `origin/${bareBase}`], worktreePath);
    } else {
      git(["worktree", "add", "--detach", worktreePath, `origin/${bareBase}`], projectDir);
    }
  } else if (reuse === false && branch !== null) {
    const localBranchExists = branchExistsLocally(git, projectDir, branch);
    if (localBranchExists) {
      git(["worktree", "add", worktreePath, branch], projectDir);
    } else {
      git(["worktree", "add", "-b", branch, worktreePath, `origin/${bareBase}`], projectDir);
    }
  }
  // Reuse (coding): the worktree already sits on the branch — no rebase, ever.

  const mergeRefs = spec
    ? resolution.mergeBranches.map((b) => `origin/${b}`)
    : [
        // Own remote branch first: absorbs deterministic refreshes pushed by
        // the pr-merged handler while this worktree lagged behind.
        ...(remoteBranchExists && branch !== null ? [`origin/${branch}`] : []),
        // Base only when the PR targets base: while stacked on an unmerged
        // blocker, folding in newer base commits would pollute the PR diff.
        // The pr-merged refresh folds base in once the blocker actually merges.
        ...(reuse && resolution.prBase === bareBase ? [`origin/${bareBase}`] : []),
        ...resolution.mergeBranches.map((b) => `origin/${b}`),
      ];

  const merged: string[] = [];
  for (const ref of mergeRefs) {
    try {
      git(["merge", "--no-edit", ref], worktreePath);
      merged.push(ref);
    } catch (err) {
      const files = git(["diff", "--name-only", "--diff-filter=U"], worktreePath)
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f !== "");
      if (files.length === 0) {
        // No unmerged entries → the merge never reached a content conflict
        // (spawn failure, dirty tree, bad ref). Reporting it as a conflict
        // would hand the coder an empty file list and an unresolvable loop.
        throw err;
      }
      if (spec) {
        // Spec mode has no resolve-and-continue loop — abort so the
        // prompt-writer explores base plus cleanly merged ancestors, not
        // conflict markers.
        git(["merge", "--abort"], worktreePath);
      }
      // Coding mode leaves the conflict in place — the coder resolves it in
      // the worktree and re-runs stack setup until it exits 0.
      return { status: "conflict", branch, files };
    }
  }

  if (spec === false && branch !== null) {
    if (pipelineState.get(issueId) === null) {
      pipelineState.create(issueId);
    }
    pipelineState.updateBranchInfo(issueId, { branchName: branch, worktreePath });
  }

  return {
    status: "ok",
    worktree: worktreePath,
    branch,
    merged,
    prBase: resolution.prBase,
  };
}

function branchExistsLocally(git: GitRun, cwd: string, branch: string): boolean {
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
    return true;
  } catch {
    return false;
  }
}

function defaultGitRun(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

export async function cmdStack(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "setup") {
    throw new CliError(`Unknown 'stack' subcommand: ${subcommand ?? "(missing)"}. Valid: setup.`);
  }

  const { positionals, values } = parseArgs({
    args: rest,
    options: {
      spec: { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("stack setup: <issueId> is required");
  }

  const ctx = loadCliContext();
  let result: StackSetupOutput;
  try {
    result = await executeStackSetup({
      issueId,
      spec: values.spec === true,
      config: ctx.config,
      issueTracker: ctx.issueTracker,
      pipelineState: ctx.pipelineState,
      git: defaultGitRun,
    });
    ctx.audit.log({
      component: "helper:stack",
      issueId,
      message: `stack setup ${values.spec === true ? "(spec) " : ""}→ ${result.status}`,
      metadata: { ...result },
    });
  } catch (err) {
    // Unexpected failure (git, network): emit JSON and exit 1 — the default
    // exit for uncaught throws is 2, which collides with the documented
    // conflict code and sends the coder into conflict resolution.
    const message = err instanceof Error ? err.message : String(err);
    ctx.audit.log({
      component: "helper:stack",
      issueId,
      message: `stack setup ${values.spec === true ? "(spec) " : ""}→ error: ${message}`,
      metadata: {},
    });
    writeJson({ status: "error", message }, values.pretty === true);
    throw new CliError(`stack setup: ${message}`, 1);
  } finally {
    ctx.cleanup();
  }

  writeJson(result, values.pretty === true);
  if (result.status === "conflict") {
    throw new CliError("stack setup: merge conflict — resolve in the worktree and re-run", 2);
  }
  if (result.status === "blocked") {
    throw new CliError("stack setup: blockers unsatisfied — issue should be parked", 3);
  }
}
