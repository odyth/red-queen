import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { parseDocument } from "yaml";
import { JiraClient } from "../integrations/jira/client.js";
import {
  discoverJiraSchema,
  type FieldCandidate,
  type PhaseOptionMatch,
} from "../integrations/jira/discover.js";
import { loadConfigFromProject } from "./config-discovery.js";
import { CliError } from "./errors.js";

const SUBCOMMANDS = ["discover"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

export async function cmdJira(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    printJiraHelp();
    return;
  }
  if (isSubcommand(sub) === false) {
    throw new CliError(`Unknown jira subcommand: ${sub}. Run 'redqueen jira --help' for usage.`);
  }
  // Only subcommand today; switch will fan out as more are added.
  await cmdJiraDiscover(rest);
}

interface DiscoverOptions {
  yes: boolean;
  dryRun: boolean;
}

async function cmdJiraDiscover(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      yes: { type: "boolean", short: "y", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help === true) {
    process.stdout.write(
      [
        "redqueen jira discover — auto-fill Jira customFields and phaseMapping",
        "Options:",
        "  -y, --yes        Apply without prompting (CI-friendly)",
        "  --dry-run        Print the proposed diff; never write",
        "",
      ].join("\n"),
    );
    return;
  }

  const opts: DiscoverOptions = {
    yes: values.yes === true,
    dryRun: values["dry-run"] === true,
  };

  const { config, configPath } = loadConfigFromProject(process.cwd());
  if (config.issueTracker.type !== "jira") {
    throw new CliError(
      `jira discover requires issueTracker.type === "jira"; got "${config.issueTracker.type}".`,
    );
  }

  const jiraConfig = parseJiraCreds(config.issueTracker.config);
  const client = new JiraClient({
    baseUrl: jiraConfig.baseUrl,
    email: jiraConfig.email,
    apiToken: jiraConfig.apiToken,
  });

  process.stdout.write(`Discovering Jira schema for project ${jiraConfig.projectKey}...\n\n`);

  const phases = config.phases.map((p) => ({ name: p.name, label: p.label }));
  const result = await discoverJiraSchema({ client, phases });

  if (result.phaseFieldCandidates.length === 0) {
    throw new CliError(
      "No phase-like single-select custom field was found. Check that the Jira project uses a custom field (not a built-in status) and that your API token can read its schema.",
    );
  }
  if (result.specFieldCandidates.length === 0) {
    throw new CliError(
      "No spec-like text field was found. Create a long-text custom field (textarea) named something like 'AI Spec' and retry.",
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const phaseField = await pickCandidate(rl, "Phase field", result.phaseFieldCandidates, opts);
    const specField = await pickCandidate(rl, "Spec field", result.specFieldCandidates, opts);

    process.stdout.write("\nProposed changes to redqueen.yaml:\n");
    process.stdout.write(
      `  issueTracker.config.customFields.phase: "${safe(jiraConfig.customFields.phase)}" -> "${phaseField.id}"\n`,
    );
    process.stdout.write(
      `  issueTracker.config.customFields.spec:  "${safe(jiraConfig.customFields.spec)}" -> "${specField.id}"\n`,
    );
    process.stdout.write("  issueTracker.config.phaseMapping:\n");

    const unmatched: string[] = [];
    for (const match of result.phaseMatches) {
      if (match.matched !== null) {
        const reasonTag =
          match.matched.reason === "fuzzy"
            ? ` (fuzzy match on "${match.matched.optionValue}")`
            : "";
        process.stdout.write(
          `    ${padName(match.phaseName)}: optionId "${match.matched.optionId}" (matched option "${match.matched.optionValue}")${reasonTag}\n`,
        );
      } else {
        unmatched.push(match.phaseName);
        process.stdout.write(
          `    ${padName(match.phaseName)}: [no match — leave as <CHANGE ME>]\n`,
        );
      }
    }
    process.stdout.write("\n");

    if (opts.dryRun) {
      process.stdout.write("Dry run — no changes written.\n");
      reportUnmatched(unmatched);
      return;
    }

    if (opts.yes === false) {
      const answer = (await rl.question("Apply these updates? [y/N]: ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        process.stdout.write("Aborted — no changes written.\n");
        return;
      }
    }

    writeDiscoveryToConfig(configPath, {
      phaseFieldId: phaseField.id,
      specFieldId: specField.id,
      matches: result.phaseMatches,
    });
    process.stdout.write(`Wrote updates to ${configPath}.\n`);
    reportUnmatched(unmatched);
  } finally {
    rl.close();
  }
}

interface JiraCreds {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  customFields: { phase: string; spec: string };
}

function parseJiraCreds(raw: Record<string, unknown>): JiraCreds {
  // The Jira adapter's own Zod schema validates customFields/phaseMapping
  // strictly (rejecting "<CHANGE ME>" downstream), but discover runs BEFORE
  // those placeholders have been filled in — we only need the connection
  // details here. Do a targeted parse so a partially-filled config doesn't
  // make the command unusable.
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl : "";
  const email = typeof raw.email === "string" ? raw.email : "";
  const apiToken = typeof raw.apiToken === "string" ? raw.apiToken : "";
  const projectKey = typeof raw.projectKey === "string" ? raw.projectKey : "";
  const cfRaw =
    typeof raw.customFields === "object" && raw.customFields !== null
      ? (raw.customFields as Record<string, unknown>)
      : {};
  const customFields = {
    phase: typeof cfRaw.phase === "string" ? cfRaw.phase : "",
    spec: typeof cfRaw.spec === "string" ? cfRaw.spec : "",
  };
  if (baseUrl.length === 0 || email.length === 0 || apiToken.length === 0) {
    throw new CliError(
      "issueTracker.config is missing baseUrl, email, or apiToken — fill these in (including $JIRA_TOKEN) before running discover.",
    );
  }
  if (projectKey.length === 0) {
    throw new CliError("issueTracker.config.projectKey is required.");
  }
  return { baseUrl, email, apiToken, projectKey, customFields };
}

async function pickCandidate(
  rl: ReturnType<typeof createInterface>,
  label: string,
  candidates: readonly FieldCandidate[],
  opts: DiscoverOptions,
): Promise<FieldCandidate> {
  process.stdout.write(`${label} candidates:\n`);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c === undefined) {
      continue;
    }
    const typeTag = c.customType ?? c.type ?? "?";
    process.stdout.write(`  [${String(i + 1)}] ${c.id}  "${c.name}"  (${typeTag})\n`);
  }
  const first = candidates[0];
  if (first === undefined) {
    // Caller already guards against empty candidates — this is defensive.
    throw new CliError(`No ${label.toLowerCase()} candidates available.`);
  }
  if (candidates.length === 1) {
    process.stdout.write(`  Picked [1] ${first.id}\n\n`);
    return first;
  }
  if (opts.yes === true) {
    throw new CliError(
      `--yes cannot disambiguate ${String(candidates.length)} ${label.toLowerCase()} candidates. ` +
        `Re-run interactively (without --yes) to pick one, or delete the unwanted ${label.toLowerCase()} in Jira so only one candidate remains.`,
    );
  }
  const answer = (await rl.question(`Pick [1-${String(candidates.length)}] (default 1): `)).trim();
  const index = answer.length === 0 ? 1 : Number.parseInt(answer, 10);
  if (Number.isFinite(index) === false || index < 1 || index > candidates.length) {
    throw new CliError(`Invalid selection "${answer}".`);
  }
  const picked = candidates[index - 1];
  if (picked === undefined) {
    throw new CliError(`Invalid selection "${answer}".`);
  }
  process.stdout.write("\n");
  return picked;
}

function padName(name: string): string {
  const width = 14;
  return name.padEnd(width);
}

function safe(value: string): string {
  return value.length === 0 ? "<unset>" : value;
}

function reportUnmatched(unmatched: readonly string[]): void {
  if (unmatched.length === 0) {
    return;
  }
  process.stdout.write("\n");
  process.stdout.write(
    `Unmatched phases — still need manual phaseMapping entries: ${unmatched.join(", ")}\n`,
  );
}

export interface DiscoveryWriteInput {
  phaseFieldId: string;
  specFieldId: string;
  matches: readonly PhaseOptionMatch[];
}

/**
 * Rewrite redqueen.yaml with the discovered IDs, preserving comments and
 * unrelated keys via the yaml Document API. Unmatched phases are left as
 * "<CHANGE ME>" so the validator still flags them on next load.
 */
export function writeDiscoveryToConfig(configPath: string, input: DiscoveryWriteInput): void {
  const existingYaml = readFileSync(configPath, "utf8");
  const doc = parseDocument(existingYaml);
  doc.setIn(["issueTracker", "config", "customFields", "phase"], input.phaseFieldId);
  doc.setIn(["issueTracker", "config", "customFields", "spec"], input.specFieldId);

  for (const match of input.matches) {
    if (match.matched === null) {
      continue;
    }
    doc.setIn(
      ["issueTracker", "config", "phaseMapping", match.phaseName, "optionId"],
      match.matched.optionId,
    );
    doc.setIn(
      ["issueTracker", "config", "phaseMapping", match.phaseName, "label"],
      match.matched.optionValue,
    );
  }

  const newYaml = doc.toString();
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, newYaml, { encoding: "utf8" });
  renameSync(tmp, configPath);
}

function printJiraHelp(): void {
  process.stdout.write(
    [
      "redqueen jira — Jira helper commands",
      "",
      "Subcommands:",
      "  discover    Auto-fill customFields and phaseMapping by querying Jira",
      "",
    ].join("\n"),
  );
}
