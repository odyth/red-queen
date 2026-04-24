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
    default:
      throw new CliError(
        `Unknown 'spec' subcommand: ${subcommand ?? "(missing)"}. Valid: get, set.`,
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
