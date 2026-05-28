import { parseArgs } from "node:util";
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
    // Keep the pipeline record's cached spec in sync so subsequent dispatches
    // (which read it into SkillContext.specContent) see the new content.
    const existing = ctx.pipelineState.get(issueId);
    if (existing !== null) {
      ctx.pipelineState.updateSpec(issueId, body);
    }
    ctx.audit.log({
      component: "helper:spec",
      issueId,
      message: "Set spec via redqueen spec set",
      metadata: { length: body.length },
    });
    writeJson({ ok: true });
  } finally {
    ctx.cleanup();
  }
}

function cmdSpecMeta(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      "open-questions": { type: "string" },
    },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("spec meta: <id> is required");
  }
  const raw = values["open-questions"];
  if (raw === undefined) {
    throw new CliError("spec meta: --open-questions <N> is required");
  }
  const count = Number.parseInt(raw, 10);
  if (Number.isNaN(count) || count < 0 || String(count) !== raw.trim()) {
    throw new CliError(`spec meta: --open-questions must be a non-negative integer, got "${raw}"`);
  }
  const ctx = loadCliContext();
  try {
    const existing = ctx.pipelineState.get(issueId);
    if (existing === null) {
      throw new CliError(`spec meta: no pipeline record for ${issueId} — run new-ticket first`);
    }
    ctx.pipelineState.setOpenQuestionCount(issueId, count);
    ctx.audit.log({
      component: "helper:spec",
      issueId,
      message: `Recorded open-question count: ${String(count)}`,
      metadata: { openQuestionCount: count },
    });
    writeJson({ issueId, openQuestionCount: count });
  } finally {
    ctx.cleanup();
  }
  return Promise.resolve();
}
