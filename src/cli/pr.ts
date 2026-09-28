import { parseArgs } from "node:util";
import { buildPhaseGraph } from "../core/config.js";
import { bareBaseBranch, resolveStack, terminalGateNames } from "../core/stack.js";
import type { Review } from "../integrations/source-control.js";
import { loadCliContext } from "./context.js";
import { CliError } from "./errors.js";
import { readBodyFromStdinOrFlag, writeJson, writeText } from "./io.js";
import { resolveRepoArg, resolveScopedRepoArg } from "./repo-arg.js";

export async function cmdPr(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "create":
      await cmdPrCreate(rest);
      return;
    case "diff":
      await cmdPrDiff(rest);
      return;
    case "checks":
      await cmdPrChecks(rest);
      return;
    case "review":
      await cmdPrReview(rest);
      return;
    case "reviews":
      await cmdPrReviews(rest);
      return;
    case "comments":
      await cmdPrComments(rest);
      return;
    case "comment":
      await cmdPrComment(rest);
      return;
    case "reply":
      await cmdPrReply(rest);
      return;
    default:
      throw new CliError(
        `Unknown 'pr' subcommand: ${subcommand ?? "(missing)"}. Valid: create, diff, checks, review, reviews, comments, comment, reply.`,
      );
  }
}

async function cmdPrCreate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      issue: { type: "string" },
      head: { type: "string" },
      base: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      draft: { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const issueId = values.issue;
  const head = values.head;
  const base = values.base;
  const title = values.title;
  if (issueId === undefined || head === undefined || base === undefined || title === undefined) {
    throw new CliError(
      "pr create: --issue, --head, --base, --title are all required; body via --body or stdin",
    );
  }
  const body = await readBodyFromStdinOrFlag(values.body, "PR body");

  const ctx = loadCliContext();
  try {
    const repo = resolveScopedRepoArg(
      ctx.config,
      ctx.pipelineState,
      issueId,
      values.repo,
      "pr create",
    );
    const sourceControl = ctx.sourceControls.get(repo.name);
    // Stacked issues target the nearest unmerged blocker's branch, and the
    // stack may have shifted since dispatch (a blocker merged mid-run) — so
    // recompute the base fresh; the coder's --base is the fallback.
    let resolvedBase = base;
    try {
      const resolution = await resolveStack(issueId, bareBaseBranch(repo.baseBranch), {
        getBlockedBy: (id) => ctx.issueTracker.getBlockedBy(id),
        getPipelineRecord: (id) => ctx.pipelineState.get(id),
        getTrackerPhase: (id) => ctx.issueTracker.getPhase(id),
        terminalGates: terminalGateNames(buildPhaseGraph(ctx.config.phases)),
        repos: ctx.config.project.repos.map((target) => ({
          name: target.name,
          bareBase: bareBaseBranch(target.baseBranch),
        })),
      });
      // Only stacked issues get overridden — a non-stacked --base (possibly a
      // deliberate custom target) passes through untouched.
      if (resolution.ok && resolution.directBlockers.length > 0) {
        resolvedBase = resolution.repos[repo.name]?.prBase ?? resolution.prBase;
      }
    } catch (err) {
      ctx.audit.log({
        component: "helper:pr",
        issueId,
        message: `pr create: stack base recompute failed — keeping --base ${base}: ${err instanceof Error ? err.message : String(err)}`,
        metadata: { base, repo: repo.name },
      });
    }
    const pr = await sourceControl.createPullRequest({
      title,
      body,
      head,
      base: resolvedBase,
      draft: values.draft === true,
    });
    if (ctx.pipelineState.get(issueId) === null) {
      ctx.pipelineState.create(issueId);
    }
    ctx.pipelineState.updateBranchInfo(issueId, repo.name, {
      branchName: head,
      prNumber: pr.number,
      prBaseBranch: resolvedBase,
    });
    ctx.audit.log({
      component: "helper:pr",
      issueId,
      message: `Created PR #${String(pr.number)} from ${head} → ${resolvedBase}`,
      metadata: { prNumber: pr.number, head, base: resolvedBase, url: pr.url, repo: repo.name },
    });
    writeJson(pr, values.pretty === true);
  } finally {
    ctx.cleanup();
  }
}

async function cmdPrDiff(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: { repo: { type: "string" } },
    allowPositionals: true,
  });
  const prNumber = parsePrNumber(positionals[0], "pr diff");
  const ctx = loadCliContext();
  try {
    const repo = resolveRepoArg(ctx.config, values.repo, "pr diff");
    const sourceControl = ctx.sourceControls.get(repo.name);
    const diff = await sourceControl.getPullRequestDiff(prNumber);
    writeText(diff);
  } finally {
    ctx.cleanup();
  }
}

async function cmdPrChecks(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      wait: { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const prNumber = parsePrNumber(positionals[0], "pr checks");

  const ctx = loadCliContext();
  try {
    const repo = resolveRepoArg(ctx.config, values.repo, "pr checks");
    const sourceControl = ctx.sourceControls.get(repo.name);
    const waitSeconds = values.wait !== undefined ? Number.parseInt(values.wait, 10) : 0;
    if (Number.isNaN(waitSeconds) || waitSeconds < 0) {
      throw new CliError("pr checks: --wait must be a non-negative integer (seconds)");
    }

    if (waitSeconds === 0) {
      const checks = await sourceControl.getChecks(prNumber);
      writeJson(checks, values.pretty === true);
      return;
    }

    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const checks = await sourceControl.getChecks(prNumber);
      const pending = checks.some((c) => c.conclusion === null || c.conclusion === "pending");
      if (pending === false || Date.now() >= deadline) {
        writeJson(checks, values.pretty === true);
        return;
      }
      await sleep(10_000);
    }
  } finally {
    ctx.cleanup();
  }
}

async function cmdPrReview(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      verdict: { type: "string" },
      body: { type: "string" },
    },
    allowPositionals: true,
  });
  const prNumber = parsePrNumber(positionals[0], "pr review");
  const verdictRaw = values.verdict;
  if (verdictRaw !== "approve" && verdictRaw !== "request-changes") {
    throw new CliError("pr review: --verdict must be 'approve' or 'request-changes'");
  }
  const verdict = verdictRaw;
  const body = await readBodyFromStdinOrFlag(values.body, "review body");
  const ctx = loadCliContext();
  try {
    const repo = resolveRepoArg(ctx.config, values.repo, "pr review");
    const sourceControl = ctx.sourceControls.get(repo.name);
    await sourceControl.postReview(prNumber, body, verdict);
    ctx.audit.log({
      component: "helper:pr",
      issueId: null,
      message: `Posted review ${verdict} on PR #${String(prNumber)}`,
      metadata: { prNumber, verdict, bodyLength: body.length, repo: repo.name },
    });
    writeJson({ ok: true });
  } finally {
    ctx.cleanup();
  }
}

async function cmdPrComments(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      pretty: { type: "boolean", default: false },
      threads: { type: "boolean", default: false },
      "include-resolved": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const prNumber = parsePrNumber(positionals[0], "pr comments");
  const unresolvedOnly = values["include-resolved"] !== true;
  const ctx = loadCliContext();
  try {
    const repo = resolveRepoArg(ctx.config, values.repo, "pr comments");
    const sourceControl = ctx.sourceControls.get(repo.name);
    const threads = await sourceControl.getReviewThreads(prNumber, { unresolvedOnly });
    if (values.threads === true) {
      writeJson(threads, values.pretty === true);
      return;
    }
    const flat = threads.flatMap((t) =>
      t.comments.map((c) => ({
        id: c.id,
        author: c.author,
        body: c.body,
        createdAt: c.createdAt,
      })),
    );
    writeJson(flat, values.pretty === true);
  } finally {
    ctx.cleanup();
  }
}

async function cmdPrReply(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: { body: { type: "string" }, repo: { type: "string" } },
    allowPositionals: true,
  });
  const prNumber = parsePrNumber(positionals[0], "pr reply");
  const commentIdRaw = positionals[1];
  if (commentIdRaw === undefined) {
    throw new CliError("pr reply: <pr-number> <comment-id> are required");
  }
  const commentId = Number.parseInt(commentIdRaw, 10);
  if (Number.isNaN(commentId)) {
    throw new CliError("pr reply: <comment-id> must be a number");
  }
  const body = await readBodyFromStdinOrFlag(values.body, "reply body");
  const ctx = loadCliContext();
  try {
    const repo = resolveRepoArg(ctx.config, values.repo, "pr reply");
    const sourceControl = ctx.sourceControls.get(repo.name);
    await sourceControl.replyToComment(prNumber, commentId, body);
    ctx.audit.log({
      component: "helper:pr",
      issueId: null,
      message: `Replied to comment ${String(commentId)} on PR #${String(prNumber)}`,
      metadata: { prNumber, commentId, repo: repo.name },
    });
    writeJson({ ok: true });
  } finally {
    ctx.cleanup();
  }
}

async function cmdPrReviews(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      latest: { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const prNumber = parsePrNumber(positionals[0], "pr reviews");
  const ctx = loadCliContext();
  try {
    const repo = resolveRepoArg(ctx.config, values.repo, "pr reviews");
    const sourceControl = ctx.sourceControls.get(repo.name);
    const reviews = await sourceControl.getReviews(prNumber);
    if (values.latest === true) {
      writeJson(pickLatestReview(reviews), values.pretty === true);
      return;
    }
    writeJson(reviews, values.pretty === true);
  } finally {
    ctx.cleanup();
  }
}

async function cmdPrComment(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: { body: { type: "string" }, repo: { type: "string" } },
    allowPositionals: true,
  });
  const prNumber = parsePrNumber(positionals[0], "pr comment");
  const body = await readBodyFromStdinOrFlag(values.body, "comment body");
  const ctx = loadCliContext();
  try {
    const repo = resolveRepoArg(ctx.config, values.repo, "pr comment");
    const sourceControl = ctx.sourceControls.get(repo.name);
    await sourceControl.postPrComment(prNumber, body);
    ctx.audit.log({
      component: "helper:pr",
      issueId: null,
      message: `Posted PR comment on PR #${String(prNumber)}`,
      metadata: { prNumber, bodyLength: body.length, repo: repo.name },
    });
    writeJson({ ok: true });
  } finally {
    ctx.cleanup();
  }
}

// Picks the review the coder reworks against: the most recently submitted
// CHANGES_REQUESTED review, whose body carries the blockers. Falls back to the
// most recent review of any state when nothing requested changes. Selecting by
// state stops a later human COMMENTED/APPROVED review from shadowing the
// actionable request-changes verdict. GitHub returns reviews oldest-first, so
// the `>=` tie-break keeps the last-seen review on equal timestamps; unsubmitted
// reviews carry an empty submittedAt and never win against a real one.
export function pickLatestReview(reviews: Review[]): Review | null {
  let latestChangesRequested: Review | null = null;
  let latestOverall: Review | null = null;
  for (const review of reviews) {
    if (latestOverall === null || review.submittedAt >= latestOverall.submittedAt) {
      latestOverall = review;
    }
    if (
      review.state === "CHANGES_REQUESTED" &&
      (latestChangesRequested === null || review.submittedAt >= latestChangesRequested.submittedAt)
    ) {
      latestChangesRequested = review;
    }
  }
  return latestChangesRequested ?? latestOverall;
}

function parsePrNumber(raw: string | undefined, cmd: string): number {
  if (raw === undefined) {
    throw new CliError(`${cmd}: <pr-number> is required`);
  }
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new CliError(`${cmd}: <pr-number> must be a number`);
  }
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}
