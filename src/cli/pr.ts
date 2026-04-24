import { parseArgs } from "node:util";
import { loadCliContext } from "./context.js";
import { CliError } from "./errors.js";
import { readBodyFromStdinOrFlag, writeJson, writeText } from "./io.js";

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
    case "comments":
      await cmdPrComments(rest);
      return;
    case "reply":
      await cmdPrReply(rest);
      return;
    default:
      throw new CliError(
        `Unknown 'pr' subcommand: ${subcommand ?? "(missing)"}. Valid: create, diff, checks, review, comments, reply.`,
      );
  }
}

async function cmdPrCreate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
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
    const pr = await ctx.sourceControl.createPullRequest({
      title,
      body,
      head,
      base,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
      draft: values.draft === true,
    });
    const existing = ctx.pipelineState.get(issueId);
    if (existing === null) {
      ctx.pipelineState.create(issueId);
    }
    ctx.pipelineState.updateBranchInfo(issueId, {
      branchName: head,
      prNumber: pr.number,
    });
    ctx.audit.log({
      component: "helper:pr",
      issueId,
      message: `Created PR #${String(pr.number)} from ${head} → ${base}`,
      metadata: { prNumber: pr.number, head, base, url: pr.url },
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
    writeJson(pr, values.pretty === true);
  } finally {
    ctx.cleanup();
  }
}

async function cmdPrDiff(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const prNumber = parsePrNumber(positionals[0], "pr diff");
  const ctx = loadCliContext();
  try {
    const diff = await ctx.sourceControl.getPullRequestDiff(prNumber);
    writeText(diff);
  } finally {
    ctx.cleanup();
  }
}

async function cmdPrChecks(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      wait: { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const prNumber = parsePrNumber(positionals[0], "pr checks");

  const ctx = loadCliContext();
  try {
    const waitSeconds = values.wait !== undefined ? Number.parseInt(values.wait, 10) : 0;
    if (Number.isNaN(waitSeconds) || waitSeconds < 0) {
      throw new CliError("pr checks: --wait must be a non-negative integer (seconds)");
    }

    if (waitSeconds === 0) {
      const checks = await ctx.sourceControl.getChecks(prNumber);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
      writeJson(checks, values.pretty === true);
      return;
    }

    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const checks = await ctx.sourceControl.getChecks(prNumber);
      const pending = checks.some((c) => c.conclusion === null || c.conclusion === "pending");
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
      if (pending === false || Date.now() >= deadline) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
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
    await ctx.sourceControl.postReview(prNumber, body, verdict);
    ctx.audit.log({
      component: "helper:pr",
      issueId: null,
      message: `Posted review ${verdict} on PR #${String(prNumber)}`,
      metadata: { prNumber, verdict, bodyLength: body.length },
    });
    writeJson({ ok: true });
  } finally {
    ctx.cleanup();
  }
}

async function cmdPrComments(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: { pretty: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const prNumber = parsePrNumber(positionals[0], "pr comments");
  const ctx = loadCliContext();
  try {
    const comments = await ctx.sourceControl.getReviewComments(prNumber);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
    writeJson(comments, values.pretty === true);
  } finally {
    ctx.cleanup();
  }
}

async function cmdPrReply(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: { body: { type: "string" } },
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
    await ctx.sourceControl.replyToComment(prNumber, commentId, body);
    ctx.audit.log({
      component: "helper:pr",
      issueId: null,
      message: `Replied to comment ${String(commentId)} on PR #${String(prNumber)}`,
      metadata: { prNumber, commentId },
    });
    writeJson({ ok: true });
  } finally {
    ctx.cleanup();
  }
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
