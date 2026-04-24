import { execSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { generateCodebaseMap, mergeRegeneratedMap } from "./codebase-map.js";
import type { CodebaseMapInput } from "./codebase-map.js";
import { detectLanguages, parseGitRemote, suggestCommands } from "./detect.js";
import type { LanguageDetection, LanguageKey } from "./detect.js";
import { CliError } from "./errors.js";
import { listTemplates, templatePath } from "./templates.js";
import type { TemplateKind } from "./templates.js";

const ALL_LANGUAGES: { key: LanguageKey; displayName: string }[] = [
  { key: "node-ts", displayName: "Node.js / TypeScript" },
  { key: "python", displayName: "Python" },
  { key: "go", displayName: "Go" },
  { key: "rust", displayName: "Rust" },
  { key: "ruby", displayName: "Ruby" },
  { key: "java", displayName: "Java / Kotlin" },
  { key: "dotnet", displayName: ".NET / C#" },
  { key: "blank", displayName: "Blank (other / unspecified)" },
];

type GitHubAuthKind = "pat" | "byo-app";

interface InitAnswers {
  primaryLanguage: LanguageKey;
  detectedLanguages: LanguageDetection[];
  buildCommand: string;
  testCommand: string;
  baseBranch: string;
  issueTrackerType: "jira" | "github-issues";
  issueTrackerConfig: Record<string, unknown>;
  sourceControlType: "github";
  sourceControlConfig: Record<string, unknown>;
  githubAuthKind: GitHubAuthKind;
  webhooksEnabled: boolean;
  webhookSecret: string | null;
  dashboardPort: number;
  codingStandardsTemplate: string;
  reviewChecklistTemplate: string;
  specTemplate: string;
}

export async function cmdInit(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      yes: { type: "boolean", short: "y", default: false },
      force: { type: "boolean", default: false },
      "map-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    process.stdout.write(
      "redqueen init — scaffold a new project (use --yes for non-interactive)\n",
    );
    return;
  }

  const projectDir = process.cwd();

  if (values["map-only"] === true) {
    await regenerateMapOnly(projectDir);
    return;
  }

  const configPath = join(projectDir, "redqueen.yaml");
  if (existsSync(configPath) && values.force !== true) {
    throw new CliError(
      "redqueen.yaml already exists. Pass --force to overwrite, or --map-only to only regenerate the codebase map.",
    );
  }

  preflight(projectDir);

  process.stdout.write("Red Queen — project setup\n\n");

  const answers =
    values.yes === true
      ? await answerWithDefaults(projectDir)
      : await interactivePrompt(projectDir);

  await writeAllFiles(projectDir, answers);

  process.stdout.write("\n");
  process.stdout.write("Setup complete.\n");
  process.stdout.write("  - redqueen.yaml         (edit to tune pipeline / adapter config)\n");
  process.stdout.write("  - .env                  (fill in your tokens — gitignored)\n");
  process.stdout.write("  - .redqueen/codebase-map.md  (edit the 'Key Notes' section)\n");
  process.stdout.write(
    "  - .redqueen/references/      (coding standards + checklist + spec template)\n",
  );
  process.stdout.write("\n");
  process.stdout.write("Next: fill in .env, then run `npx redqueen start`.\n");
  process.stdout.write(
    "Tip: ask Claude Code to tailor .redqueen/references/ to this codebase — the templates are a starting point.\n",
  );
}

function preflight(projectDir: string): void {
  try {
    execSync("git rev-parse --show-toplevel", { cwd: projectDir, stdio: "pipe" });
  } catch {
    throw new CliError(
      "redqueen init must run inside a git repository. Run `git init` first, then retry.",
    );
  }
}

async function interactivePrompt(projectDir: string): Promise<InitAnswers> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const detected = detectLanguages(projectDir);
    if (detected.length > 0) {
      const names = detected.map((d) => `${d.displayName} (${d.markerFile})`).join(", ");
      process.stdout.write(`Detected: ${names}\n`);
    } else {
      process.stdout.write("No language markers detected.\n");
    }

    const primaryLanguage = await pickPrimaryLanguage(rl, detected);
    const suggested = suggestCommands(primaryLanguage, projectDir);
    const buildCommand = await promptCommand(rl, "Build command", suggested.build);
    const testCommand = await promptCommand(rl, "Test command", suggested.test);
    const baseBranch = await pickBaseBranch(rl, projectDir);

    const githubAuthKind = await pickGitHubAuthKind(rl);
    const githubAuthBlock = buildGitHubAuthBlock(githubAuthKind);
    const { issueTrackerType, issueTrackerConfig } = await pickIssueTracker(
      rl,
      projectDir,
      githubAuthBlock,
    );
    const { sourceControlType, sourceControlConfig } = await pickSourceControl(
      rl,
      projectDir,
      githubAuthBlock,
    );
    const { webhooksEnabled, webhookSecret } = await pickWebhooks(rl);
    const dashboardPort = await pickDashboardPort(rl);

    const codingStandardsTemplate = await pickTemplate(
      rl,
      "coding-standards",
      "Coding standards template",
      primaryLanguage === "blank" ? "blank" : primaryLanguage,
    );
    const reviewChecklistTemplate = await pickTemplate(
      rl,
      "review-checklist",
      "Review checklist template",
      "web-api",
    );
    const specTemplate = "generic";

    return {
      primaryLanguage,
      detectedLanguages: detected,
      buildCommand,
      testCommand,
      baseBranch,
      issueTrackerType,
      issueTrackerConfig,
      sourceControlType,
      sourceControlConfig,
      githubAuthKind,
      webhooksEnabled,
      webhookSecret,
      dashboardPort,
      codingStandardsTemplate,
      reviewChecklistTemplate,
      specTemplate,
    };
  } finally {
    rl.close();
  }
}

async function answerWithDefaults(projectDir: string): Promise<InitAnswers> {
  const detected = detectLanguages(projectDir);
  const primary: LanguageKey = detected[0]?.key ?? "blank";
  const suggested = suggestCommands(primary, projectDir);
  const baseBranch = detectDefaultBranch(projectDir) ?? "origin/main";

  const remote = readGitRemote(projectDir);
  const parsed = remote !== null ? parseGitRemote(remote) : null;
  const owner = parsed?.owner ?? "";
  const repo = parsed?.repo ?? "";

  const patAuth = buildGitHubAuthBlock("pat");
  return Promise.resolve({
    primaryLanguage: primary,
    detectedLanguages: detected,
    buildCommand: suggested.build.length > 0 ? suggested.build : "npm run build",
    testCommand: suggested.test.length > 0 ? suggested.test : "npm test",
    baseBranch,
    issueTrackerType: "github-issues",
    issueTrackerConfig: {
      owner,
      repo,
      auth: patAuth,
    },
    sourceControlType: "github",
    sourceControlConfig: {
      owner,
      repo,
      auth: patAuth,
    },
    githubAuthKind: "pat",
    webhooksEnabled: false,
    webhookSecret: null,
    dashboardPort: 4400,
    codingStandardsTemplate: primary === "blank" ? "blank" : primary,
    reviewChecklistTemplate: "web-api",
    specTemplate: "generic",
  });
}

async function pickPrimaryLanguage(
  rl: ReturnType<typeof createInterface>,
  detected: LanguageDetection[],
): Promise<LanguageKey> {
  if (detected.length === 1) {
    const only = detected[0];
    if (only !== undefined) {
      const resp = await rl.question(`Using ${only.displayName} as primary language. [Y/n]: `);
      if (resp.trim().toLowerCase() === "n") {
        return pickFromFullList(rl);
      }
      return only.key;
    }
  }
  if (detected.length > 1) {
    process.stdout.write("Multiple languages detected. Pick primary:\n");
    detected.forEach((d, i) => {
      process.stdout.write(`  [${String(i + 1)}] ${d.displayName}\n`);
    });
    const resp = await rl.question("Choice [1]: ");
    const trimmed = resp.trim();
    const idx = trimmed === "" ? 0 : Number.parseInt(trimmed, 10) - 1;
    const pick = detected[idx] ?? detected[0];
    if (pick !== undefined) {
      return pick.key;
    }
  }
  return pickFromFullList(rl);
}

async function pickFromFullList(rl: ReturnType<typeof createInterface>): Promise<LanguageKey> {
  process.stdout.write("Pick primary language:\n");
  ALL_LANGUAGES.forEach((l, i) => {
    process.stdout.write(`  [${String(i + 1)}] ${l.displayName}\n`);
  });
  for (;;) {
    const resp = await rl.question("Choice: ");
    const idx = Number.parseInt(resp.trim(), 10) - 1;
    const pick = ALL_LANGUAGES[idx];
    if (pick !== undefined) {
      return pick.key;
    }
    process.stdout.write("Invalid choice. Try again.\n");
  }
}

async function promptCommand(
  rl: ReturnType<typeof createInterface>,
  label: string,
  suggested: string,
): Promise<string> {
  const prompt =
    suggested.length > 0 ? `${label} [${suggested}]: ` : `${label} (no suggestion, enter one): `;
  for (;;) {
    const resp = (await rl.question(prompt)).trim();
    if (resp.length === 0) {
      if (suggested.length > 0) {
        return suggested;
      }
      process.stdout.write(`${label} cannot be empty.\n`);
      continue;
    }
    return resp;
  }
}

async function pickBaseBranch(
  rl: ReturnType<typeof createInterface>,
  projectDir: string,
): Promise<string> {
  const detected = detectDefaultBranch(projectDir);
  if (detected !== null) {
    const resp = (
      await rl.question(`Default branch detected: ${detected}. Use this as base branch? [Y/n]: `)
    )
      .trim()
      .toLowerCase();
    if (resp === "" || resp === "y") {
      return detected;
    }
  }
  const answer = (await rl.question("Enter base branch [origin/main]: ")).trim();
  const chosen = answer.length > 0 ? answer : "origin/main";
  return chosen.startsWith("origin/") ? chosen : `origin/${chosen}`;
}

function detectDefaultBranch(projectDir: string): string | null {
  try {
    const out = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (out.startsWith("refs/remotes/")) {
      return out.slice("refs/remotes/".length);
    }
  } catch {
    // fall through
  }
  try {
    const out = execSync(
      "gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null",
      { cwd: projectDir, encoding: "utf8" },
    ).trim();
    if (out.length > 0) {
      return `origin/${out}`;
    }
  } catch {
    // fall through
  }
  return null;
}

function readGitRemote(projectDir: string): string | null {
  try {
    return execSync("git remote get-url origin", {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function pickIssueTracker(
  rl: ReturnType<typeof createInterface>,
  projectDir: string,
  githubAuthBlock: Record<string, unknown>,
): Promise<{
  issueTrackerType: "jira" | "github-issues";
  issueTrackerConfig: Record<string, unknown>;
}> {
  process.stdout.write("Issue tracker:\n");
  process.stdout.write("  [1] jira\n");
  process.stdout.write("  [2] github-issues\n");
  const resp = (await rl.question("Choice [2]: ")).trim();
  const pick = resp === "" || resp === "2" ? "github-issues" : "jira";

  if (pick === "github-issues") {
    const remote = readGitRemote(projectDir);
    const parsed = remote !== null ? parseGitRemote(remote) : null;
    const owner = await rl.question(`GitHub owner [${parsed?.owner ?? ""}]: `);
    const repo = await rl.question(`GitHub repo [${parsed?.repo ?? ""}]: `);
    return {
      issueTrackerType: "github-issues",
      issueTrackerConfig: {
        owner: owner.trim().length > 0 ? owner.trim() : (parsed?.owner ?? ""),
        repo: repo.trim().length > 0 ? repo.trim() : (parsed?.repo ?? ""),
        auth: githubAuthBlock,
      },
    };
  }
  const baseUrl = (await rl.question("Jira base URL (e.g. https://yourco.atlassian.net): ")).trim();
  const email = (await rl.question("Jira account email: ")).trim();
  const cloudId = (await rl.question("Jira cloud ID: ")).trim();
  const projectKey = (await rl.question("Jira project key: ")).trim();
  return {
    issueTrackerType: "jira",
    issueTrackerConfig: {
      baseUrl,
      email,
      apiToken: "${JIRA_TOKEN}",
      cloudId,
      projectKey,
      customFields: {
        phase: "<CHANGE ME>",
        spec: "<CHANGE ME>",
      },
      phaseMapping: {
        "spec-writing": { optionId: "<CHANGE ME>" },
        "spec-review": { optionId: "<CHANGE ME>" },
        coding: { optionId: "<CHANGE ME>" },
        "code-review": { optionId: "<CHANGE ME>" },
        testing: { optionId: "<CHANGE ME>" },
        "human-review": { optionId: "<CHANGE ME>" },
        "spec-feedback": { optionId: "<CHANGE ME>" },
        "code-feedback": { optionId: "<CHANGE ME>" },
        blocked: { optionId: "<CHANGE ME>" },
      },
    },
  };
}

async function pickSourceControl(
  rl: ReturnType<typeof createInterface>,
  projectDir: string,
  githubAuthBlock: Record<string, unknown>,
): Promise<{
  sourceControlType: "github";
  sourceControlConfig: Record<string, unknown>;
}> {
  const remote = readGitRemote(projectDir);
  const parsed = remote !== null ? parseGitRemote(remote) : null;
  const owner = await rl.question(`GitHub owner [${parsed?.owner ?? ""}]: `);
  const repo = await rl.question(`GitHub repo [${parsed?.repo ?? ""}]: `);
  return {
    sourceControlType: "github",
    sourceControlConfig: {
      owner: owner.trim().length > 0 ? owner.trim() : (parsed?.owner ?? ""),
      repo: repo.trim().length > 0 ? repo.trim() : (parsed?.repo ?? ""),
      auth: githubAuthBlock,
    },
  };
}

async function pickGitHubAuthKind(rl: ReturnType<typeof createInterface>): Promise<GitHubAuthKind> {
  process.stdout.write("GitHub auth:\n");
  process.stdout.write("  [1] personal access token (PAT) — simplest, runs as you\n");
  process.stdout.write("  [2] bring-your-own GitHub App — bot identity, no seat consumed\n");
  const resp = (await rl.question("Choice [1]: ")).trim();
  return resp === "2" ? "byo-app" : "pat";
}

function buildGitHubAuthBlock(kind: GitHubAuthKind): Record<string, unknown> {
  if (kind === "pat") {
    return { type: "pat", token: "${GITHUB_PAT}" };
  }
  return {
    type: "byo-app",
    appId: "${GITHUB_APP_ID}",
    installationId: "${GITHUB_APP_INSTALLATION_ID}",
    privateKeyPath: "${GITHUB_APP_KEY_PATH}",
  };
}

async function pickWebhooks(
  rl: ReturnType<typeof createInterface>,
): Promise<{ webhooksEnabled: boolean; webhookSecret: string | null }> {
  const resp = (await rl.question("Enable webhook receiver? [y/N]: ")).trim().toLowerCase();
  if (resp !== "y") {
    return { webhooksEnabled: false, webhookSecret: null };
  }
  // Secrets never live in the yaml file. Default to an env var ref; the user
  // fills in the real value in .env.
  return {
    webhooksEnabled: true,
    webhookSecret: "${REDQUEEN_WEBHOOK_SECRET}",
  };
}

async function pickDashboardPort(rl: ReturnType<typeof createInterface>): Promise<number> {
  const resp = (await rl.question("Dashboard port [4400]: ")).trim();
  if (resp.length === 0) {
    return 4400;
  }
  const n = Number.parseInt(resp, 10);
  if (Number.isNaN(n) || n < 1 || n > 65535) {
    process.stdout.write("Invalid port. Using 4400.\n");
    return 4400;
  }
  return n;
}

async function pickTemplate(
  rl: ReturnType<typeof createInterface>,
  kind: TemplateKind,
  label: string,
  suggestedKey: string,
): Promise<string> {
  const options = listTemplates(kind);
  if (options.length === 0) {
    throw new CliError(`No templates found for ${kind}. Is the installation complete?`);
  }
  process.stdout.write(`${label}:\n`);
  options.forEach((opt, i) => {
    const marker = opt === suggestedKey ? " (suggested)" : "";
    process.stdout.write(`  [${String(i + 1)}] ${opt}${marker}\n`);
  });
  const defaultIdx = options.indexOf(suggestedKey);
  const defaultLabel = defaultIdx >= 0 ? String(defaultIdx + 1) : "1";
  const resp = (await rl.question(`Choice [${defaultLabel}]: `)).trim();
  const idx = resp === "" ? defaultIdx : Number.parseInt(resp, 10) - 1;
  const pick = options[idx] ?? options[defaultIdx >= 0 ? defaultIdx : 0];
  return pick ?? options[0] ?? suggestedKey;
}

async function writeAllFiles(projectDir: string, answers: InitAnswers): Promise<void> {
  const redqueenDir = join(projectDir, ".redqueen");
  const referencesDir = join(redqueenDir, "references");
  const skillsDir = join(redqueenDir, "skills");

  mkdirSync(redqueenDir, { recursive: true });
  mkdirSync(referencesDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(redqueenDir, ".gitkeep"), "");
  writeFileSync(join(skillsDir, ".gitkeep"), "");

  writeConfigFile(join(projectDir, "redqueen.yaml"), answers);

  // Codebase map.
  const mapInput: CodebaseMapInput = {
    projectDir,
    languages: answers.detectedLanguages,
    primary: answers.primaryLanguage,
    buildCommand: answers.buildCommand,
    testCommand: answers.testCommand,
    generatedAt: new Date().toISOString().slice(0, 10),
  };
  writeFileSync(join(redqueenDir, "codebase-map.md"), generateCodebaseMap(mapInput));

  // Reference templates.
  copyTemplate(
    "coding-standards",
    answers.codingStandardsTemplate,
    join(referencesDir, "coding-standards.md"),
  );
  copyTemplate(
    "review-checklist",
    answers.reviewChecklistTemplate,
    join(referencesDir, "review-checklist.md"),
  );
  copyTemplate("spec-template", answers.specTemplate, join(referencesDir, "spec-template.md"));

  updateGitignore(projectDir);
  writeDotEnvScaffold(projectDir, answers);

  return Promise.resolve();
}

function writeDotEnvScaffold(projectDir: string, answers: InitAnswers): void {
  const envPath = join(projectDir, ".env");
  const needed: string[] = [];
  if (answers.githubAuthKind === "pat") {
    needed.push("GITHUB_PAT");
  } else {
    needed.push("GITHUB_APP_ID");
    needed.push("GITHUB_APP_INSTALLATION_ID");
    needed.push("GITHUB_APP_KEY_PATH");
  }
  if (answers.issueTrackerType === "jira") {
    needed.push("JIRA_TOKEN");
  }
  if (answers.webhooksEnabled) {
    needed.push("REDQUEEN_WEBHOOK_SECRET");
  }

  if (needed.length === 0) {
    return;
  }

  const lines = [
    "# Red Queen secrets — filled in by you, gitignored.",
    "# Each key is referenced by redqueen.yaml as ${KEY}.",
    "",
    ...needed.map((key) => `${key}=`),
    "",
  ];

  if (existsSync(envPath) === false) {
    writeFileSync(envPath, lines.join("\n"), { encoding: "utf8" });
    return;
  }
  const existing = readFileSync(envPath, "utf8");
  const missing = needed.filter((key) => existing.includes(`${key}=`) === false);
  if (missing.length === 0) {
    return;
  }
  appendFileSync(envPath, `\n${missing.map((k) => `${k}=`).join("\n")}\n`);
}

function writeConfigFile(path: string, answers: InitAnswers): void {
  const config: Record<string, unknown> = {
    issueTracker: {
      type: answers.issueTrackerType,
      config: answers.issueTrackerConfig,
    },
    sourceControl: {
      type: answers.sourceControlType,
      config: answers.sourceControlConfig,
    },
    pipeline: {
      baseBranch: answers.baseBranch,
      ...(answers.webhooksEnabled
        ? {
            webhooks: {
              enabled: true,
              secret: answers.webhookSecret ?? "<CHANGE ME>",
            },
          }
        : {}),
    },
    project: {
      buildCommand: answers.buildCommand,
      testCommand: answers.testCommand,
    },
    dashboard: {
      port: answers.dashboardPort,
    },
  };

  const yaml = stringifyYaml(config, { lineWidth: 0 });
  const commentedModules = [
    "",
    "# Optional: per-module commands for multi-module repos.",
    "# project:",
    "#   modules:",
    "#     - name: web",
    '#       paths: ["src/web/**"]',
    "#       buildCommand: npm run build --workspace=web",
    "#       testCommandTargeted: npm test --workspace=web",
    "",
  ].join("\n");
  writeAtomic(path, `${yaml}${commentedModules}`);
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8" });
  renameSync(tmp, path);
}

function copyTemplate(kind: TemplateKind, choice: string, destPath: string): void {
  const source = templatePath(kind, choice);
  if (existsSync(source) === false) {
    throw new CliError(`Template not found: ${kind}/${choice}.md`);
  }
  copyFileSync(source, destPath);
}

function updateGitignore(projectDir: string): void {
  const gitignorePath = join(projectDir, ".gitignore");
  const block = [
    "",
    "# Red Queen",
    ".env",
    ".redqueen/redqueen.db",
    ".redqueen/redqueen.db-*",
    ".redqueen/redqueen.pid",
    ".redqueen/worktrees/",
    ".redqueen/attachments/",
    "",
  ].join("\n");

  if (existsSync(gitignorePath) === false) {
    writeFileSync(gitignorePath, block.trimStart(), { encoding: "utf8" });
    return;
  }
  const existing = readFileSync(gitignorePath, "utf8");
  if (existing.includes(".redqueen/redqueen.db") && existing.includes(".env")) {
    return;
  }
  appendFileSync(gitignorePath, block);
}

async function regenerateMapOnly(projectDir: string): Promise<void> {
  const configPath = join(projectDir, "redqueen.yaml");
  if (existsSync(configPath) === false) {
    throw new CliError("Cannot run --map-only without a redqueen.yaml in the current directory.");
  }
  const mapPath = resolve(projectDir, ".redqueen", "codebase-map.md");
  if (existsSync(mapPath) === false) {
    throw new CliError(".redqueen/codebase-map.md does not exist — run `redqueen init` first.");
  }
  const detected = detectLanguages(projectDir);
  const primary: LanguageKey = detected[0]?.key ?? "blank";
  const yaml = readFileSync(configPath, "utf8");
  const { buildCommand: build, testCommand: test } = readProjectCommands(yaml);
  const regenerated = generateCodebaseMap({
    projectDir,
    languages: detected,
    primary,
    buildCommand: build,
    testCommand: test,
    generatedAt: new Date().toISOString().slice(0, 10),
  });
  const existing = readFileSync(mapPath, "utf8");
  const merged = mergeRegeneratedMap(existing, regenerated);
  writeFileSync(mapPath, merged);
  process.stdout.write("Regenerated .redqueen/codebase-map.md (Key Notes preserved).\n");
  return Promise.resolve();
}

function readProjectCommands(yaml: string): { buildCommand: string; testCommand: string } {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch {
    return { buildCommand: "", testCommand: "" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { buildCommand: "", testCommand: "" };
  }
  const project = (parsed as { project?: unknown }).project;
  if (typeof project !== "object" || project === null) {
    return { buildCommand: "", testCommand: "" };
  }
  const p = project as { buildCommand?: unknown; testCommand?: unknown };
  return {
    buildCommand: typeof p.buildCommand === "string" ? p.buildCommand : "",
    testCommand: typeof p.testCommand === "string" ? p.testCommand : "",
  };
}
