import { parseArgs } from "node:util";
import { loadCliContext } from "./context.js";
import { CliError } from "./errors.js";
import { readBodyFromStdinOrFlag, writeJson } from "./io.js";

export async function cmdSubIter(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "start":
      await cmdSubIterStart(rest);
      return;
    case "complete":
      await cmdSubIterComplete(rest);
      return;
    case "latest":
      await cmdSubIterLatest(rest);
      return;
    default:
      throw new CliError(
        `Unknown 'sub-iter' subcommand: ${subcommand ?? "(missing)"}. Valid: start, complete, latest.`,
      );
  }
}

function cmdSubIterStart(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  const label = positionals[1];
  if (issueId === undefined) {
    throw new CliError("sub-iter start: <issueId> is required");
  }
  if (label === undefined || label.length === 0) {
    throw new CliError("sub-iter start: <label> is required");
  }

  const ctx = loadCliContext();
  try {
    const record = ctx.pipelineState.get(issueId);
    if (record === null) {
      throw new CliError(
        `sub-iter start: no pipeline record for ${issueId} — run new-ticket first`,
      );
    }
    const phaseName = record.currentPhase;
    if (phaseName === null) {
      throw new CliError(`sub-iter start: pipeline record for ${issueId} has no current phase`);
    }
    const sub = ctx.subIteration.start({ issueId, phaseName, label });
    ctx.audit.log({
      component: "helper:sub-iter",
      issueId,
      message: `Sub-iteration started: ${phaseName} iter ${String(sub.subIterIndex)} — ${label}`,
      metadata: {
        phase: phaseName,
        subIterIndex: sub.subIterIndex,
        label,
      },
    });
    writeJson(sub, values.pretty === true);
  } finally {
    ctx.cleanup();
  }
  return Promise.resolve();
}

async function cmdSubIterComplete(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      summary: { type: "string" },
      "summary-stdin": { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("sub-iter complete: <issueId> is required");
  }
  // Research/design summaries can be multi-KB — stdin avoids argv length
  // limits. Either --summary "..." or --summary-stdin must be present.
  let summary: string;
  if (values["summary-stdin"] === true) {
    summary = await readBodyFromStdinOrFlag(undefined, "summary");
  } else if (values.summary !== undefined && values.summary.length > 0) {
    summary = values.summary;
  } else {
    throw new CliError("sub-iter complete: --summary or --summary-stdin is required");
  }

  const ctx = loadCliContext();
  try {
    const record = ctx.pipelineState.get(issueId);
    if (record === null) {
      throw new CliError(
        `sub-iter complete: no pipeline record for ${issueId} — run new-ticket first`,
      );
    }
    const phaseName = record.currentPhase;
    if (phaseName === null) {
      throw new CliError(`sub-iter complete: pipeline record for ${issueId} has no current phase`);
    }
    const sub = ctx.subIteration.completeLatestOpen({
      issueId,
      phaseName,
      summary,
    });
    if (sub === null) {
      throw new CliError(`sub-iter complete: no open sub-iteration for ${issueId}`);
    }
    ctx.audit.log({
      component: "helper:sub-iter",
      issueId,
      message: `Sub-iteration completed: ${sub.phaseName} iter ${String(sub.subIterIndex)} — ${sub.label}`,
      metadata: {
        phase: sub.phaseName,
        subIterIndex: sub.subIterIndex,
        label: sub.label,
        summary,
      },
    });
    writeJson(sub, values.pretty === true);
  } finally {
    ctx.cleanup();
  }
}

function cmdSubIterLatest(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      phase: { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("sub-iter latest: <issueId> is required");
  }
  if (values.phase === undefined || values.phase.length === 0) {
    throw new CliError("sub-iter latest: --phase <name> is required");
  }

  const ctx = loadCliContext();
  try {
    // Writes `null` (and exits 0) when no completed sub-iteration exists, so
    // callers can branch on JSON null instead of a non-zero exit.
    const sub = ctx.subIteration.latestCompleted(issueId, values.phase);
    writeJson(sub, values.pretty === true);
  } finally {
    ctx.cleanup();
  }
  return Promise.resolve();
}
