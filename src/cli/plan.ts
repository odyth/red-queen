import { parseArgs } from "node:util";
import type { PlanReviewVerdictKind } from "../core/types.js";
import { loadCliContext } from "./context.js";
import { CliError } from "./errors.js";
import { writeJson } from "./io.js";

export async function cmdPlan(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "verdict":
      await cmdPlanVerdict(rest);
      return;
    default:
      throw new CliError(
        `Unknown 'plan' subcommand: ${subcommand ?? "(missing)"}. Valid: verdict.`,
      );
  }
}

function parseNonNegativeInt(raw: string, field: string): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0 || String(n) !== raw.trim()) {
    throw new CliError(`plan verdict: --${field} must be a non-negative integer`);
  }
  return n;
}

function parseVerdictKind(raw: string): PlanReviewVerdictKind {
  if (raw === "approve" || raw === "request-changes") {
    return raw;
  }
  throw new CliError(
    `plan verdict: --verdict must be "approve" or "request-changes" (got "${raw}")`,
  );
}

function cmdPlanVerdict(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      verdict: { type: "string" },
      rating: { type: "string" },
      blockers: { type: "string" },
      "open-questions": { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("plan verdict: <issueId> is required");
  }
  if (values.verdict === undefined) {
    throw new CliError("plan verdict: --verdict is required");
  }
  if (values.rating === undefined) {
    throw new CliError("plan verdict: --rating is required");
  }
  if (values.blockers === undefined) {
    throw new CliError("plan verdict: --blockers is required");
  }
  if (values["open-questions"] === undefined) {
    throw new CliError("plan verdict: --open-questions is required");
  }

  const verdictKind = parseVerdictKind(values.verdict);
  const rating = Number.parseInt(values.rating, 10);
  if (
    Number.isNaN(rating) ||
    rating < 1 ||
    rating > 10 ||
    String(rating) !== values.rating.trim()
  ) {
    throw new CliError("plan verdict: --rating must be an integer in [1, 10]");
  }
  const blockers = parseNonNegativeInt(values.blockers, "blockers");
  const openQuestions = parseNonNegativeInt(values["open-questions"], "open-questions");

  const ctx = loadCliContext();
  try {
    const existing = ctx.pipelineState.get(issueId);
    if (existing === null) {
      throw new CliError(`plan verdict: no pipeline record for ${issueId} — run new-ticket first`);
    }
    const recordedAt = new Date().toISOString();
    const persisted = ctx.pipelineState.setPlanReviewVerdict(issueId, {
      verdict: verdictKind,
      rating,
      blockers,
      openQuestions,
      recordedAt,
    });
    if (persisted === false) {
      throw new CliError(`plan verdict: failed to persist verdict for ${issueId}`);
    }
    ctx.audit.log({
      component: "helper:plan",
      issueId,
      message: `Plan review verdict recorded: ${verdictKind} (rating ${String(rating)}/10, ${String(blockers)} blockers, ${String(openQuestions)} open questions)`,
      metadata: { verdict: verdictKind, rating, blockers, openQuestions },
    });
    writeJson(
      {
        ok: true,
        issueId,
        verdict: verdictKind,
        rating,
        blockers,
        openQuestions,
        recordedAt,
      },
      values.pretty === true,
    );
  } finally {
    ctx.cleanup();
  }
  return Promise.resolve();
}
