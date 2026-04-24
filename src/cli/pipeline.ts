import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadCliContext } from "./context.js";
import { CliError } from "./errors.js";
import { writeJson } from "./io.js";

export async function cmdPipeline(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "update":
      await cmdPipelineUpdate(rest);
      return;
    case "cleanup":
      await cmdPipelineCleanup(rest);
      return;
    default:
      throw new CliError(
        `Unknown 'pipeline' subcommand: ${subcommand ?? "(missing)"}. Valid: update, cleanup.`,
      );
  }
}

function cmdPipelineUpdate(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      branch: { type: "string" },
      pr: { type: "string" },
      worktree: { type: "string" },
      "clear-pr": { type: "boolean", default: false },
      "clear-worktree": { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("pipeline update: <issueId> is required");
  }

  const update: {
    branchName?: string | null;
    prNumber?: number | null;
    worktreePath?: string | null;
  } = {};
  if (values.branch !== undefined) {
    update.branchName = values.branch;
  }
  if (values.pr !== undefined) {
    const n = Number.parseInt(values.pr, 10);
    if (Number.isNaN(n)) {
      throw new CliError("pipeline update: --pr must be a number");
    }
    update.prNumber = n;
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
  if (values["clear-pr"] === true) {
    update.prNumber = null;
  }
  if (values.worktree !== undefined) {
    update.worktreePath = values.worktree;
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
  if (values["clear-worktree"] === true) {
    update.worktreePath = null;
  }

  const ctx = loadCliContext();
  try {
    const existing = ctx.pipelineState.get(issueId);
    if (existing === null) {
      ctx.pipelineState.create(issueId);
    }
    const updated = ctx.pipelineState.updateBranchInfo(issueId, update);
    ctx.audit.log({
      component: "helper:pipeline",
      issueId,
      message: `Updated pipeline state: ${Object.keys(update).join(", ") || "(no-op)"}`,
      metadata: update,
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
    writeJson(updated, values.pretty === true);
  } finally {
    ctx.cleanup();
  }
  return Promise.resolve();
}

function cmdPipelineCleanup(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      "keep-branch": { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("pipeline cleanup: <issueId> is required");
  }

  const ctx = loadCliContext();
  const removed: string[] = [];
  try {
    const record = ctx.pipelineState.get(issueId);
    if (record === null) {
      throw new CliError(`pipeline cleanup: no pipeline record for ${issueId}`);
    }
    const worktreePath = record.worktreePath;
    if (worktreePath !== null && existsSync(worktreePath)) {
      try {
        const gitArgs = ["worktree", "remove", worktreePath];
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
        if (values["keep-branch"] !== true) {
          gitArgs.push("--force");
        }
        execFileSync("git", gitArgs, { stdio: ["ignore", "pipe", "pipe"] });
        removed.push(worktreePath);
      } catch (err) {
        ctx.audit.log({
          component: "helper:pipeline",
          issueId,
          message: `Worktree removal failed: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { worktreePath },
        });
      }
    }
    ctx.pipelineState.updateBranchInfo(issueId, { worktreePath: null });
    ctx.audit.log({
      component: "helper:pipeline",
      issueId,
      message: `Cleaned up pipeline state (worktree cleared)`,
      metadata: { removed },
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
    writeJson({ ok: true, removed }, values.pretty === true);
    return Promise.resolve();
  } finally {
    ctx.cleanup();
  }
}
