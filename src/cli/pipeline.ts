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
  if (values["clear-pr"] === true) {
    update.prNumber = null;
  }
  if (values.worktree !== undefined) {
    update.worktreePath = values.worktree;
  }
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
    const projectDir = ctx.config.project.directory;
    const worktreePath = record.worktreePath;
    if (worktreePath !== null && existsSync(worktreePath)) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
          cwd: projectDir,
          stdio: ["ignore", "pipe", "pipe"],
        });
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

    const branchName = record.branchName;
    const deletedBranch = values["keep-branch"] !== true && branchName !== null;
    if (deletedBranch) {
      try {
        execFileSync("git", ["branch", "-D", branchName], {
          cwd: projectDir,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        ctx.audit.log({
          component: "helper:pipeline",
          issueId,
          message: `Branch deletion failed for ${branchName}: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { branchName },
        });
      }
    }

    ctx.pipelineState.updateBranchInfo(issueId, {
      worktreePath: null,
      ...(deletedBranch ? { branchName: null } : {}),
    });
    ctx.audit.log({
      component: "helper:pipeline",
      issueId,
      message: `Cleaned up pipeline state (worktree cleared${deletedBranch ? ", branch deleted" : ""})`,
      metadata: { removed, branchDeleted: deletedBranch ? branchName : null },
    });
    writeJson(
      { ok: true, removed, branchDeleted: deletedBranch ? branchName : null },
      values.pretty === true,
    );
    return Promise.resolve();
  } finally {
    ctx.cleanup();
  }
}
