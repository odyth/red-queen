import { parseArgs } from "node:util";
import { normalizeSpec, sha256Hex } from "../core/strings.js";
import { loadCliContext } from "./context.js";
import { CliError } from "./errors.js";
import { readBodyFromStdinOrFlag, writeJson, writeText } from "./io.js";

export async function cmdSpec(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "get":
      await cmdSpecGet(rest);
      return;
    case "set":
      await cmdSpecSet(rest);
      return;
    case "meta":
      await cmdSpecMeta(rest);
      return;
    default:
      throw new CliError(
        `Unknown 'spec' subcommand: ${subcommand ?? "(missing)"}. Valid: get, set, meta.`,
      );
  }
}

async function cmdSpecGet(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("spec get: <id> is required");
  }
  const ctx = loadCliContext();
  try {
    const spec = await ctx.issueTracker.getSpec(issueId);
    writeText(spec ?? "");
  } finally {
    ctx.cleanup();
  }
}

async function cmdSpecSet(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: { body: { type: "string" } },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("spec set: <id> is required");
  }
  const body = await readBodyFromStdinOrFlag(values.body, "spec body");
  const ctx = loadCliContext();
  try {
    await ctx.issueTracker.setSpec(issueId, body);
    // Server-side audit layer (Decision 6): parse the Open Questions section so
    // the orchestrator can route on max(declared, parsed). Hash + timestamp let
    // the orchestrator detect human inline edits before the next writer
    // dispatch — normalizeSpec/sha256Hex are the single source of truth shared
    // with the orchestrator's humanModifiedSpec pre-compute.
    const parsedOpenQuestionCount = countUncheckedOpenQuestions(body);
    const lastAiSpecHash = sha256Hex(normalizeSpec(body));
    const lastAiSpecAt = new Date().toISOString();
    // Keep the pipeline record's cached spec in sync (subsequent dispatches read
    // it into SkillContext.specContent) and record the audit columns atomically.
    const existing = ctx.pipelineState.get(issueId);
    if (existing !== null) {
      ctx.pipelineState.recordSpecWrite(issueId, {
        specContent: body,
        parsedOpenQuestionCount,
        lastAiSpecHash,
        lastAiSpecAt,
      });
    }
    ctx.audit.log({
      component: "helper:spec",
      issueId,
      message: "Set spec via redqueen spec set",
      metadata: { length: body.length, parsedOpenQuestionCount },
    });
    writeJson({ ok: true, parsedOpenQuestionCount });
  } finally {
    ctx.cleanup();
  }
}

function cmdSpecMeta(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      "open-questions": { type: "string" },
      "files-affected": { type: "string" },
    },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("spec meta: <id> is required");
  }
  const openQuestions = parseNonNegativeCount(values["open-questions"], "--open-questions");
  const filesAffected = parseNonNegativeCount(values["files-affected"], "--files-affected");
  if (openQuestions === undefined && filesAffected === undefined) {
    throw new CliError(
      "spec meta: at least one of --open-questions or --files-affected is required",
    );
  }

  const ctx = loadCliContext();
  try {
    const existing = ctx.pipelineState.get(issueId);
    if (existing === null) {
      throw new CliError(`spec meta: no pipeline record for ${issueId} — run new-ticket first`);
    }
    if (openQuestions !== undefined) {
      ctx.pipelineState.setOpenQuestionCount(issueId, openQuestions);
    }
    if (filesAffected !== undefined) {
      ctx.pipelineState.setFilesAffectedCount(issueId, filesAffected);
    }
    ctx.audit.log({
      component: "helper:spec",
      issueId,
      message: "Set spec metadata via redqueen spec meta",
      metadata: {
        openQuestionCount: openQuestions ?? null,
        filesAffectedCount: filesAffected ?? null,
      },
    });
    writeJson({
      ok: true,
      openQuestionCount: openQuestions ?? null,
      filesAffectedCount: filesAffected ?? null,
    });
  } finally {
    ctx.cleanup();
  }
  return Promise.resolve();
}

function parseNonNegativeCount(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new CliError(`spec meta: ${flag} must be a non-negative integer`);
  }
  return n;
}

// Counts unchecked `- [ ]` items inside the `## Open Questions` section.
// The heading match is intentionally strict (`/^#+\s+open questions\s*$/i`) —
// the writer skill is told decorated headings ("Open Questions (3)") are
// silently skipped, so calibration lives in the prompt, not here.
function countUncheckedOpenQuestions(body: string): number {
  const lines = body.split("\n");
  let inSection = false;
  let count = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#+\s/.test(line)) {
      inSection = /^#+\s+open questions\s*$/i.test(line);
      continue;
    }
    if (inSection && /^- \[\s\]/.test(line)) {
      count++;
    }
  }
  return count;
}
