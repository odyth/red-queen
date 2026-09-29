import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { gitCwdFor } from "../core/worktree-layout.js";
import { buildPhaseGraph } from "../core/config.js";
import { resumePipeline } from "../core/pipeline-recovery.js";
import { loadCliContext } from "./context.js";
import { CliError } from "./errors.js";
import { writeJson } from "./io.js";
import { resolveScopedRepoArg } from "./repo-arg.js";

export async function cmdPipeline(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "resume":
      await cmdPipelineResume(rest);
      return;
    case "update":
      await cmdPipelineUpdate(rest);
      return;
    case "cleanup":
      await cmdPipelineCleanup(rest);
      return;
    default:
      throw new CliError(
        `Unknown 'pipeline' subcommand: ${subcommand ?? "(missing)"}. Valid: update, cleanup, resume.`,
      );
  }
}

async function cmdPipelineResume(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: { pretty: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined || positionals.length !== 1) {
    throw new CliError("pipeline resume: exactly one <issueId> is required");
  }
  const ctx = loadCliContext();
  try {
    const task = await resumePipeline(
      { ...ctx, phaseGraph: buildPhaseGraph(ctx.config.phases) },
      issueId,
    );
    writeJson({ ok: true, task }, values.pretty === true);
  } finally {
    ctx.cleanup();
  }
}

function cmdPipelineUpdate(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
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
    prBaseBranch?: string | null;
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
    // A PR number and its recorded base are one identity. Carrying the old
    // PR's base across a manual replacement makes stack-retarget decisions
    // confidently wrong; unknown is safe and can still be resolved live.
    update.prBaseBranch = null;
  }
  if (values["clear-pr"] === true) {
    update.prNumber = null;
    update.prBaseBranch = null;
  }
  if (values.worktree !== undefined) {
    update.worktreePath = values.worktree;
  }
  if (values["clear-worktree"] === true) {
    update.worktreePath = null;
  }

  const ctx = loadCliContext();
  try {
    const repo = resolveScopedRepoArg(
      ctx.config,
      ctx.pipelineState,
      issueId,
      values.repo,
      "pipeline update",
    );
    if (ctx.pipelineState.get(issueId) === null) {
      ctx.pipelineState.create(issueId);
    }
    ctx.pipelineState.updateBranchInfo(issueId, repo.name, update);
    ctx.audit.log({
      component: "helper:pipeline",
      issueId,
      message: `Updated pipeline state for ${repo.name}: ${Object.keys(update).join(", ") || "(no-op)"}`,
      metadata: { ...update, repo: repo.name },
    });
    writeJson(ctx.pipelineState.get(issueId), values.pretty === true);
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

  const ctx = loadCliContext({ allowUnconfiguredRepos: true });
  const removed: string[] = [];
  try {
    const record = ctx.pipelineState.get(issueId);
    if (record === null) {
      throw new CliError(`pipeline cleanup: no pipeline record for ${issueId}`);
    }
    const branchDeleted: string[] = [];
    const dropped: string[] = [];
    const configured = ctx.config.project.repos.map((repo) => repo.name);
    // This explicit administrative command also cleans descoped orphan rows.
    for (const row of record.repos) {
      if (configured.includes(row.repo) === false) {
        // No repo path is left to run git in, so the artifacts are reported
        // for a human and only the row is removed.
        ctx.pipelineState.deleteRepo(issueId, row.repo);
        ctx.audit.log({
          component: "helper:pipeline",
          issueId,
          message: `Dropped the row for ${row.repo}, which project.repos no longer names; its branch, PR, and worktree were left in place`,
          metadata: {
            repo: row.repo,
            branchName: row.branchName,
            prNumber: row.prNumber,
            worktreePath: row.worktreePath,
          },
        });
        dropped.push(row.repo);
        continue;
      }
      const cwd = gitCwdFor(ctx.config, row.repo);
      const { worktreePath, branchName } = row;
      let worktreeRemoved = true;
      if (worktreePath !== null && existsSync(worktreePath)) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", "--", worktreePath], {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
          });
          removed.push(worktreePath);
        } catch (err) {
          worktreeRemoved = existsSync(worktreePath) === false;
          ctx.audit.log({
            component: "helper:pipeline",
            issueId,
            message: `Worktree removal failed: ${err instanceof Error ? err.message : String(err)}`,
            metadata: { repo: row.repo, worktreePath },
          });
        }
      }

      let branchRemoved = false;
      if (values["keep-branch"] !== true && branchName !== null && worktreeRemoved) {
        try {
          execFileSync("git", ["branch", "-D", "--", branchName], {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
          });
          branchRemoved = true;
          branchDeleted.push(`${row.repo}:${branchName}`);
        } catch (err) {
          // A crash can leave metadata after deleting the actual branch.
          // Only show-ref's missing-ref exit status confirms it is absent;
          // spawn errors and repository failures must retain retry evidence.
          try {
            execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
              cwd,
              stdio: ["ignore", "pipe", "pipe"],
            });
          } catch (lookupError) {
            branchRemoved =
              typeof lookupError === "object" &&
              lookupError !== null &&
              "status" in lookupError &&
              lookupError.status === 1;
          }
          if (branchRemoved === false) {
            ctx.audit.log({
              component: "helper:pipeline",
              issueId,
              message: `Branch deletion failed for ${branchName}: ${err instanceof Error ? err.message : String(err)}`,
              metadata: { repo: row.repo, branchName },
            });
          }
        }
      }

      ctx.pipelineState.updateBranchInfo(issueId, row.repo, {
        ...(worktreeRemoved ? { worktreePath: null } : {}),
        ...(branchRemoved ? { branchName: null } : {}),
      });
    }
    ctx.audit.log({
      component: "helper:pipeline",
      issueId,
      message: "Pipeline cleanup attempted for every recorded repository",
      metadata: { removed, branchDeleted, dropped },
    });
    writeJson(
      { ok: true, removed, branchDeleted, ...(dropped.length > 0 ? { dropped } : {}) },
      values.pretty === true,
    );
    return Promise.resolve();
  } finally {
    ctx.cleanup();
  }
}
