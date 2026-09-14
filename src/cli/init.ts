import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { isNode, parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import type { Document } from "yaml";
import { interpolateEnv, parseConfig, resolveProjectPaths } from "../core/config.js";
import type { RedQueenConfig, RepoConfig } from "../core/config.js";
import { RedQueenDatabase } from "../core/database.js";
import { loadDotEnv } from "../core/env.js";
import { PipelineStateStore } from "../core/pipeline-state.js";
import { contextFromConfig, createServiceManager } from "../core/service/index.js";
import {
  generateCodebaseMap,
  generateWorkspaceMap,
  isWorkspaceMap,
  mergeRegeneratedMap,
  renderRepoSection,
} from "./codebase-map.js";
import type { CodebaseMapInput } from "./codebase-map.js";
import {
  appendRepo,
  liftLegacyToRepos,
  readYamlDocument,
  writeYamlDocument,
} from "./config-edit.js";
import { detectLanguages, parseGitRemote, suggestCommands } from "./detect.js";
import type { LanguageDetection, LanguageKey } from "./detect.js";
import { CliError } from "./errors.js";
import { printHelp } from "./help.js";
import { isProcessAlive, readPidFile, resolvePidPath } from "./pid.js";
import {
  deriveRepoEntry,
  detectDefaultBranch,
  discoverRepoChildren,
  isGitWorkTreeRoot,
  listRegisteredWorktrees,
  readGitRemote,
} from "./repo-discovery.js";
import type { DiscoveredRepo, RepoEntryDerivation } from "./repo-discovery.js";
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
  webhookPublicBaseUrl: string | null;
  webhookIssueTrackerPath: string | null;
  webhookSourceControlPath: string | null;
  dashboardPort: number;
  codingStandardsTemplate: string;
  reviewChecklistTemplate: string;
  specTemplate: string;
}

interface IWorkspaceInitAnswers extends Omit<
  InitAnswers,
  "primaryLanguage" | "detectedLanguages" | "buildCommand" | "testCommand" | "baseBranch"
> {
  repos: RepoEntryDerivation[];
}

type InitMode = { kind: "single" } | { kind: "workspace"; children: DiscoveredRepo[] };

export async function cmdInit(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      yes: { type: "boolean", short: "y", default: false },
      force: { type: "boolean", default: false },
      "map-only": { type: "boolean", default: false },
      "add-repo": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    printHelp("init");
    return;
  }

  const projectDir = process.cwd();

  if (values["add-repo"] !== undefined) {
    if (values["map-only"] === true || values.force === true) {
      throw new CliError("--add-repo cannot be combined with --map-only or --force.");
    }
    if (values["add-repo"].trim() === "") {
      throw new CliError("--add-repo needs a non-empty repository path.");
    }
    await addRepo(projectDir, resolve(projectDir, values["add-repo"]));
    return;
  }

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

  const mode = detectMode(projectDir);

  process.stdout.write("Red Queen — project setup\n\n");

  if (mode.kind === "workspace") {
    const answers =
      values.yes === true
        ? workspaceAnswersWithDefaults(projectDir, mode.children)
        : await workspaceInteractivePrompt(projectDir, mode.children);
    writeWorkspaceFiles(projectDir, answers);
    printWorkspaceNextSteps(answers);
    return;
  }

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
  if (answers.issueTrackerType === "jira") {
    process.stdout.write(
      "Next: run `redqueen jira discover` to auto-fill customFields and phaseMapping.\n",
    );
  }
  process.stdout.write(
    "Tip: ask Claude Code to tailor .redqueen/references/ to this codebase — the templates are a starting point.\n",
  );
}

// Validate all normal settings, but omit adapter credentials from the temporary
// projection: a local config edit must work before tokens or App keys are set.
// The original document, including every auth placeholder, is what we write.
function configForRepoEdit(doc: Document, configDir: string): RedQueenConfig {
  // Resolve aliases before selecting auth.type (getIn does not traverse an
  // alias). This plain object is only used for validation, never serialized
  // back over the user's document.
  const raw = doc.toJS() as Record<string, unknown>;
  // Root-level extension/anchor definitions are ignored by ConfigSchema. They
  // may hold shared credentials, so exclude them before env interpolation too.
  const configKeys = new Set([
    "issueTracker",
    "sourceControl",
    "project",
    "pipeline",
    "phases",
    "skills",
    "dashboard",
    "audit",
    "service",
  ]);
  const validation = Object.fromEntries(Object.entries(raw).filter(([key]) => configKeys.has(key)));
  for (const adapter of ["issueTracker", "sourceControl"]) {
    const adapterValue = validation[adapter];
    if (typeof adapterValue !== "object" || adapterValue === null) {
      continue;
    }
    const adapterRecord = adapterValue as Record<string, unknown>;
    const configValue = adapterRecord.config;
    if (typeof configValue !== "object" || configValue === null || Array.isArray(configValue)) {
      continue;
    }
    const adapterConfig = configValue as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const key of ["owner", "repo"]) {
      if (adapterConfig[key] !== undefined) {
        projected[key] = adapterConfig[key];
      }
    }
    const auth = adapterConfig.auth;
    const authType =
      typeof auth === "object" && auth !== null ? (auth as { type?: unknown }).type : undefined;
    if (authType !== undefined) {
      projected.auth = { type: authType };
    }
    const secret = adapterConfig.webhookSecret;
    if (secret !== undefined) {
      projected.webhookSecret =
        typeof secret === "string"
          ? secret.replace(/\$\{[A-Z_][A-Z0-9_]*\}/g, "pending-secret")
          : secret;
    }
    adapterRecord.config = projected;
  }
  const config = resolveProjectPaths(parseConfig(stringifyYaml(validation)), configDir);
  const scAuth = config.sourceControl.config.auth as { type?: unknown } | undefined;
  const trackerAuth = config.issueTracker.config.auth as { type?: unknown } | undefined;
  const paired =
    config.sourceControl.type === "github" && config.issueTracker.type === "github-issues";
  const effectiveAuth = scAuth ?? (paired ? trackerAuth : undefined);
  if (effectiveAuth?.type === "byo-app") {
    const owners = config.project.repos.map((repo) => repo.owner.toLowerCase());
    if (paired) {
      const trackerOwner = config.issueTracker.config.owner;
      if (typeof trackerOwner !== "string" || trackerOwner.length === 0) {
        throw new CliError(
          "GitHub App auth requires an owner for the paired GitHub Issues tracker.",
        );
      }
      owners.push(trackerOwner.toLowerCase());
    }
    if (new Set(owners).size > 1) {
      throw new CliError(
        "GitHub App auth requires the same owner for all repos and the paired tracker — use PAT auth or split the workspace.",
      );
    }
  }
  return config;
}

function preflightLegacyRepoEdit(rootDir: string, projectDir: string): void {
  if (
    isGitWorkTreeRoot(rootDir) === false ||
    existsSync(projectDir) === false ||
    realpathSync(projectDir) !== realpathSync(rootDir)
  ) {
    throw new CliError(
      "In-place --add-repo requires project.directory to resolve to the git root containing redqueen.yaml. Align the config and state root first, then use `redqueen migrate` for a layout change.",
    );
  }
  const pid = readPidFile(resolvePidPath(projectDir));
  if (pid !== null && isProcessAlive(pid)) {
    throw new CliError(
      "The legacy orchestrator is running. Stop it with `redqueen stop` before --add-repo; use `redqueen migrate` to preserve in-flight worktrees.",
    );
  }
  const worktreeRoot = join(realpathSync(projectDir), ".redqueen", "worktrees");
  const hasWorktreeFiles =
    existsSync(worktreeRoot) && readdirSync(worktreeRoot).some((entry) => entry !== ".gitkeep");
  const hasRegisteredWorktrees = listRegisteredWorktrees(projectDir).some((record) =>
    record.path.startsWith(`${worktreeRoot}${sep}`),
  );
  if (hasWorktreeFiles || hasRegisteredWorktrees) {
    throw new CliError(
      "Legacy worktrees exist under .redqueen/worktrees. Run `redqueen migrate` to move them safely before adding a repo.",
    );
  }
  const dbPath = join(projectDir, ".redqueen", "redqueen.db");
  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      // Older databases may not have pipeline_repos or worktree_path yet.
      // Inspect without running schema migrations during preflight.
      for (const table of ["pipeline_state", "pipeline_repos"]) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (
          columns.some((column) => column.name === "worktree_path") &&
          db.prepare(`SELECT 1 FROM ${table} WHERE worktree_path IS NOT NULL LIMIT 1`).get() !==
            undefined
        ) {
          throw new CliError(
            "Legacy state still records a worktree path. Run `redqueen migrate` to preserve that state before adding a repo.",
          );
        }
      }
    } finally {
      db.close();
    }
  }
}

function mapForAddedRepo(mapPath: string, config: RedQueenConfig): string {
  const input = {
    rootDir: config.project.directory,
    generatedAt: new Date().toISOString().slice(0, 10),
    repos: config.project.repos.map((repo) => {
      const languages = detectLanguages(repo.path);
      return { ...repo, languages, primary: languages[0]?.key ?? ("blank" as const) };
    }),
  };
  const mapStat = lstatSync(mapPath, { throwIfNoEntry: false });
  if (mapStat === undefined) {
    return generateWorkspaceMap(input);
  }
  if (mapStat.isFile() === false) {
    throw new CliError(`Cannot update ${mapPath}: the codebase map must be a regular file.`);
  }
  const added = input.repos.at(-1);
  if (added === undefined) {
    throw new CliError("Cannot generate a map without the added repository.");
  }
  const existing = readFileSync(mapPath, "utf8");
  // A legacy flat map has exactly one possible owner. The shared merge keeps
  // its complete Key Notes block before we append the newly added section.
  const previous = isWorkspaceMap(existing)
    ? existing
    : mergeRegeneratedMap(
        existing,
        generateWorkspaceMap({ ...input, repos: input.repos.slice(0, -1) }),
      );
  return `${previous}${previous.endsWith("\n\n") ? "" : previous.endsWith("\n") ? "\n" : "\n\n"}${renderRepoSection(added)}`;
}

async function addRepo(configDir: string, repoPath: string): Promise<void> {
  const configPath = join(configDir, "redqueen.yaml");
  if (existsSync(configPath) === false) {
    throw new CliError("--add-repo needs an existing redqueen.yaml in the current directory.");
  }
  if (lstatSync(configPath).isFile() === false) {
    throw new CliError(`Cannot rewrite ${configPath}: the destination must be a regular file`);
  }
  loadDotEnv(configDir, 0);
  const doc = readYamlDocument(configPath);
  const directory: unknown = doc.getIn(["project", "directory"]);
  if (directory !== undefined && typeof directory !== "string") {
    throw new CliError("project.directory must be a string.");
  }
  const projectDir = resolve(configDir, interpolateEnv(directory ?? "."));
  let lifted: RepoConfig | null = null;
  if (doc.hasIn(["project", "repos"]) === false) {
    preflightLegacyRepoEdit(configDir, projectDir);
    lifted = liftLegacyToRepos(doc, ".");
  }
  const derived = deriveRepoEntry(repoPath, projectDir);
  // cwd is canonical on macOS while an absolute argument may use /var or /tmp
  // aliases. Derive the stored relative path from their canonical identities.
  const canonicalRelative = relative(realpathSync(projectDir), realpathSync(repoPath))
    .split(sep)
    .join("/");
  derived.entry.path = canonicalRelative.startsWith("../")
    ? canonicalRelative
    : `./${canonicalRelative}`;
  appendRepo(doc, derived.entry);
  const config = configForRepoEdit(doc, configDir);
  validateWorkspaceRepos(projectDir, config.project.repos);
  const mapPath = join(projectDir, ".redqueen", "codebase-map.md");
  const map = mapForAddedRepo(mapPath, config);
  if (lifted !== null && (process.platform === "darwin" || process.platform === "linux")) {
    const service = await createServiceManager().status(contextFromConfig(config, projectDir, ""));
    if (service.running) {
      throw new CliError(
        "The legacy service is running. Stop it with `redqueen service stop` before --add-repo; use `redqueen migrate` for in-flight worktrees.",
      );
    }
    // Service inspection is asynchronous; recheck the PID and worktrees before
    // the first write in case an orchestrator started while status was read.
    preflightLegacyRepoEdit(configDir, projectDir);
  }

  const dbPath = join(projectDir, ".redqueen", "redqueen.db");
  if (lifted !== null && existsSync(dbPath)) {
    const database = new RedQueenDatabase(dbPath);
    try {
      // Adoption before publishing the new mode preserves modern legacy specs.
      // It is also safe/idempotent if a subsequent file write fails: the old
      // legacy config already uses this same repo identity.
      new PipelineStateStore(
        database.db,
        config.project.repos.map((repo) => repo.name),
      ).adoptLegacyRows(lifted.name, true);
    } finally {
      database.close();
    }
  }
  mkdirSync(join(projectDir, ".redqueen"), { recursive: true });
  writeYamlDocument(configPath, doc);
  writeFileSync(mapPath, map);
  process.stdout.write(
    `Added repo ${derived.entry.name} (${derived.entry.path}) to redqueen.yaml${lifted === null ? "" : ` and converted the install to workspace mode (${lifted.name} at .)`}.\n`,
  );
  if (config.pipeline.webhooks.enabled) {
    process.stdout.write(
      "Add a source-control webhook on the new repo pointing at the same URL with the same secret.\n",
    );
  }
  process.stdout.write("Restart the orchestrator to pick up the new repo.\n");
}

function detectMode(projectDir: string): InitMode {
  if (isGitWorkTreeRoot(projectDir)) {
    return { kind: "single" };
  }
  const children = discoverRepoChildren(projectDir);
  if (children.length > 0) {
    return { kind: "workspace", children };
  }
  try {
    // Preserve legacy init in ordinary subdirectories of a git work tree.
    execSync("git rev-parse --show-toplevel", { cwd: projectDir, stdio: "pipe" });
    return { kind: "single" };
  } catch {
    throw new CliError(
      "redqueen init must run inside a git repository or in a folder that contains git repositories (a workspace root). Run `git init` first, or cd to the parent of your repos.",
    );
  }
}

function deriveWorkspaceRepos(rootDir: string, children: DiscoveredRepo[]): RepoEntryDerivation[] {
  const repos = children.map((child) => deriveRepoEntry(child.path, rootDir));
  validateWorkspaceRepos(
    rootDir,
    repos.map((repo) => repo.entry),
  );
  return repos;
}

function validateWorkspaceRepos(rootDir: string, repos: readonly RepoConfig[]): void {
  const paths = new Set<string>();
  const names = new Set<string>();
  const upstreams = new Set<string>();
  for (const repo of repos) {
    const path = resolve(rootDir, repo.path);
    if (isGitWorkTreeRoot(path) === false) {
      throw new CliError(`Repository ${repo.name} at ${path} is not a git work tree root`);
    }
    const canonicalPath = realpathSync(path);
    if (paths.has(canonicalPath)) {
      throw new CliError(`Duplicate repo path: ${path} resolves to the same path as another repo`);
    }
    const upstream = `${repo.owner}/${repo.repo}`.toLowerCase();
    if (upstreams.has(upstream)) {
      throw new CliError(`Duplicate upstream repository: ${repo.owner}/${repo.repo}`);
    }
    if (names.has(repo.name)) {
      throw new CliError(`Duplicate repo name "${repo.name}"`);
    }
    paths.add(canonicalPath);
    upstreams.add(upstream);
    names.add(repo.name);
  }
}

function workspaceAnswersWithDefaults(
  rootDir: string,
  children: DiscoveredRepo[],
): IWorkspaceInitAnswers {
  const repos = deriveWorkspaceRepos(rootDir, children);
  const first = repos[0];
  if (first === undefined) {
    throw new CliError("No repos selected.");
  }
  process.stdout.write(`Discovered ${String(repos.length)} repos:\n`);
  for (const { entry } of repos) {
    process.stdout.write(`  - ${entry.name}  ${entry.path}  (${entry.owner}/${entry.repo})\n`);
  }
  const auth = buildGitHubAuthBlock("pat");
  return {
    repos,
    issueTrackerType: "github-issues",
    issueTrackerConfig: { owner: first.entry.owner, repo: first.entry.repo, auth },
    sourceControlType: "github",
    sourceControlConfig: { auth },
    githubAuthKind: "pat",
    webhooksEnabled: false,
    webhookPublicBaseUrl: null,
    webhookIssueTrackerPath: null,
    webhookSourceControlPath: null,
    dashboardPort: 4400,
    codingStandardsTemplate: first.primary,
    reviewChecklistTemplate: "web-api",
    specTemplate: "generic",
  };
}

async function workspaceInteractivePrompt(
  rootDir: string,
  children: DiscoveredRepo[],
): Promise<IWorkspaceInitAnswers> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`Workspace root: ${rootDir}\nDiscovered git repositories:\n`);
    const chosen: DiscoveredRepo[] = [];
    for (const child of children) {
      const remote = child.remote === null ? null : parseGitRemote(child.remote);
      const label =
        remote === null ? "origin missing or invalid" : `${remote.owner}/${remote.repo}`;
      const response = (await rl.question(`Include ${child.dirName} (${label})? [Y/n]: `))
        .trim()
        .toLowerCase();
      if (response !== "n" && response !== "no") {
        chosen.push(child);
      }
    }
    if (chosen.length === 0) {
      throw new CliError("No repos selected.");
    }
    const repos = deriveWorkspaceRepos(rootDir, chosen);
    for (const { entry } of repos) {
      entry.buildCommand = await promptCommand(
        rl,
        `${entry.name}: build command`,
        entry.buildCommand,
      );
      entry.testCommand = await promptCommand(rl, `${entry.name}: test command`, entry.testCommand);
    }
    const first = repos[0];
    if (first === undefined) {
      throw new CliError("No repos selected.");
    }
    const githubAuthKind = await pickGitHubAuthKind(rl);
    const githubAuthBlock = buildGitHubAuthBlock(githubAuthKind);
    const webhookAnswers = await pickWebhooks(rl);
    const { issueTrackerType, issueTrackerConfig } = await pickIssueTracker(
      rl,
      resolve(rootDir, first.entry.path),
      githubAuthBlock,
      webhookAnswers.webhooksEnabled,
    );
    const sourceControlConfig: Record<string, unknown> = { auth: githubAuthBlock };
    if (webhookAnswers.webhooksEnabled) {
      sourceControlConfig.webhookSecret = "${GITHUB_WEBHOOK_SECRET}";
    }
    const dashboardPort = await pickDashboardPort(rl);
    const codingStandardsTemplate = await pickTemplate(
      rl,
      "coding-standards",
      "Coding standards template",
      first.primary,
    );
    const reviewChecklistTemplate = await pickTemplate(
      rl,
      "review-checklist",
      "Review checklist template",
      "web-api",
    );
    return {
      repos,
      issueTrackerType,
      issueTrackerConfig,
      sourceControlType: "github",
      sourceControlConfig,
      githubAuthKind,
      webhooksEnabled: webhookAnswers.webhooksEnabled,
      webhookPublicBaseUrl: webhookAnswers.publicBaseUrl,
      webhookIssueTrackerPath: webhookAnswers.issueTrackerPath,
      webhookSourceControlPath: webhookAnswers.sourceControlPath,
      dashboardPort,
      codingStandardsTemplate,
      reviewChecklistTemplate,
      specTemplate: "generic",
    };
  } finally {
    rl.close();
  }
}

function workspaceConfigYaml(answers: IWorkspaceInitAnswers): string {
  const baseBranch = answers.repos[0]?.entry.baseBranch ?? "origin/main";
  const config = {
    issueTracker: { type: answers.issueTrackerType, config: answers.issueTrackerConfig },
    sourceControl: { type: answers.sourceControlType, config: answers.sourceControlConfig },
    pipeline: pipelineConfig(baseBranch, answers),
    project: {
      repos: answers.repos.map(({ entry }) => ({
        name: entry.name,
        path: entry.path,
        owner: entry.owner,
        repo: entry.repo,
        ...(entry.baseBranch === baseBranch ? {} : { baseBranch: entry.baseBranch }),
        buildCommand: entry.buildCommand,
        testCommand: entry.testCommand,
      })),
    },
    dashboard: { port: answers.dashboardPort },
  };
  const yaml = stringifyYaml(config, { lineWidth: 0 });
  // Validate the candidate without needing the credentials that this command
  // is about to scaffold. Serialize the original placeholders, never secrets.
  const validated = parseConfig(
    interpolateEnv(yaml, {
      ...process.env,
      GITHUB_PAT: "init-placeholder",
      GITHUB_APP_ID: "1",
      GITHUB_APP_INSTALLATION_ID: "1",
      GITHUB_APP_KEY_PATH: "init-placeholder.pem",
      GITHUB_WEBHOOK_SECRET: "init-placeholder",
      JIRA_TOKEN: "init-placeholder",
      JIRA_WEBHOOK_SECRET: "init-placeholder",
    }),
  );
  if (answers.githubAuthKind === "byo-app" && answers.issueTrackerType === "github-issues") {
    const owners = [
      ...validated.project.repos.map((repo) => repo.owner),
      String(validated.issueTracker.config.owner),
    ];
    if (new Set(owners.map((owner) => owner.toLowerCase())).size > 1) {
      throw new CliError(
        "GitHub App auth requires the same owner for project.repos[] and the paired GitHub Issues tracker — use PAT auth or choose a tracker under that owner.",
      );
    }
  }
  return `${yaml}\n${[
    "# Optional: per-module commands inside one repo (paths are repo-relative).",
    "# project:",
    "#   repos:",
    "#     - name: <repo>",
    "#       modules:",
    "#         - name: web",
    '#           paths: ["src/web/**"]',
    "#           buildCommand: npm run build --workspace=web",
    "#           testCommandTargeted: npm test --workspace=web",
    "",
  ].join("\n")}`;
}

function writeWorkspaceFiles(rootDir: string, answers: IWorkspaceInitAnswers): void {
  // Recheck the selected roots/origins after interactive prompts and finish
  // config validation and map rendering before creating any scaffolding.
  validateWorkspaceRepos(
    rootDir,
    answers.repos.map((repo) => repo.entry),
  );
  for (const { entry } of answers.repos) {
    const remote = readGitRemote(resolve(rootDir, entry.path));
    if (remote === null || parseGitRemote(remote) === null) {
      throw new CliError(`Repository ${entry.name} has no valid 'origin' remote`);
    }
  }
  const config = parseDocument(workspaceConfigYaml(answers));
  const map = generateWorkspaceMap({
    rootDir,
    generatedAt: new Date().toISOString().slice(0, 10),
    repos: answers.repos.map(({ entry, languages, primary }) => ({
      ...entry,
      path: resolve(rootDir, entry.path),
      languages,
      primary,
    })),
  });
  const redqueenDir = join(rootDir, ".redqueen");
  const referencesDir = join(redqueenDir, "references");
  const skillsDir = join(redqueenDir, "skills");
  mkdirSync(referencesDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(redqueenDir, ".gitkeep"), "");
  writeFileSync(join(skillsDir, ".gitkeep"), "");
  writeYamlDocument(join(rootDir, "redqueen.yaml"), config);
  writeFileSync(join(redqueenDir, "codebase-map.md"), map);
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
  const rootIsRepo = isGitWorkTreeRoot(rootDir);
  if (rootIsRepo) {
    updateGitignore(rootDir);
  }
  writeDotEnvScaffold(rootDir, answers, rootIsRepo);
}

function printWorkspaceNextSteps(answers: IWorkspaceInitAnswers): void {
  process.stdout.write("\nSetup complete (workspace mode).\n");
  process.stdout.write("  - redqueen.yaml              (project.repos[] — one entry per repo)\n");
  process.stdout.write("  - .env                       (fill in your tokens)\n");
  process.stdout.write("  - .redqueen/codebase-map.md  (edit each repo's '(edit me)' blocks)\n");
  process.stdout.write(
    "  - .redqueen/references/      (coding standards + checklist + spec template)\n",
  );
  process.stdout.write("\nNext: fill in .env, then run `npx redqueen start`.\n");
  if (answers.webhooksEnabled) {
    process.stdout.write(
      "Next: add a source-control webhook on every repo (or one org-level webhook) pointing at the same URL with the same secret.\n",
    );
  }
  if (answers.issueTrackerType === "jira") {
    process.stdout.write(
      "Next: run `redqueen jira discover` to auto-fill customFields and phaseMapping.\n",
    );
  }
  process.stdout.write("Tip: `redqueen init --add-repo <path>` appends another repo later.\n");
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
    const webhookAnswers = await pickWebhooks(rl);
    const { issueTrackerType, issueTrackerConfig } = await pickIssueTracker(
      rl,
      projectDir,
      githubAuthBlock,
      webhookAnswers.webhooksEnabled,
    );
    const { sourceControlType, sourceControlConfig } = await pickSourceControl(
      rl,
      projectDir,
      githubAuthBlock,
      webhookAnswers.webhooksEnabled,
    );
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
      webhooksEnabled: webhookAnswers.webhooksEnabled,
      webhookPublicBaseUrl: webhookAnswers.publicBaseUrl,
      webhookIssueTrackerPath: webhookAnswers.issueTrackerPath,
      webhookSourceControlPath: webhookAnswers.sourceControlPath,
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
    webhookPublicBaseUrl: null,
    webhookIssueTrackerPath: null,
    webhookSourceControlPath: null,
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

async function pickIssueTracker(
  rl: ReturnType<typeof createInterface>,
  projectDir: string,
  githubAuthBlock: Record<string, unknown>,
  webhooksEnabled: boolean,
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
    const base: Record<string, unknown> = {
      owner: owner.trim().length > 0 ? owner.trim() : (parsed?.owner ?? ""),
      repo: repo.trim().length > 0 ? repo.trim() : (parsed?.repo ?? ""),
      auth: githubAuthBlock,
    };
    if (webhooksEnabled) {
      base.webhookSecret = "${GITHUB_WEBHOOK_SECRET}";
    }
    return {
      issueTrackerType: "github-issues",
      issueTrackerConfig: base,
    };
  }
  const baseUrl = (await rl.question("Jira base URL (e.g. https://yourco.atlassian.net): ")).trim();
  const email = (await rl.question("Jira account email: ")).trim();
  const cloudId = (await rl.question("Jira cloud ID: ")).trim();
  const projectKey = (await rl.question("Jira project key: ")).trim();
  const jiraConfig: Record<string, unknown> = {
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
      "spec-awaiting-info": { optionId: "<CHANGE ME>" },
      coding: { optionId: "<CHANGE ME>" },
      "code-review": { optionId: "<CHANGE ME>" },
      testing: { optionId: "<CHANGE ME>" },
      "human-review": { optionId: "<CHANGE ME>" },
      "spec-feedback": { optionId: "<CHANGE ME>" },
      "code-feedback": { optionId: "<CHANGE ME>" },
      blocked: { optionId: "<CHANGE ME>" },
    },
  };
  if (webhooksEnabled) {
    jiraConfig.webhookSecret = "${JIRA_WEBHOOK_SECRET}";
  }
  return {
    issueTrackerType: "jira",
    issueTrackerConfig: jiraConfig,
  };
}

async function pickSourceControl(
  rl: ReturnType<typeof createInterface>,
  projectDir: string,
  githubAuthBlock: Record<string, unknown>,
  webhooksEnabled: boolean,
): Promise<{
  sourceControlType: "github";
  sourceControlConfig: Record<string, unknown>;
}> {
  const remote = readGitRemote(projectDir);
  const parsed = remote !== null ? parseGitRemote(remote) : null;
  const owner = await rl.question(`GitHub owner [${parsed?.owner ?? ""}]: `);
  const repo = await rl.question(`GitHub repo [${parsed?.repo ?? ""}]: `);
  const base: Record<string, unknown> = {
    owner: owner.trim().length > 0 ? owner.trim() : (parsed?.owner ?? ""),
    repo: repo.trim().length > 0 ? repo.trim() : (parsed?.repo ?? ""),
    auth: githubAuthBlock,
  };
  if (webhooksEnabled) {
    base.webhookSecret = "${GITHUB_WEBHOOK_SECRET}";
  }
  return {
    sourceControlType: "github",
    sourceControlConfig: base,
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

async function pickWebhooks(rl: ReturnType<typeof createInterface>): Promise<{
  webhooksEnabled: boolean;
  publicBaseUrl: string | null;
  issueTrackerPath: string | null;
  sourceControlPath: string | null;
}> {
  const resp = (await rl.question("Enable webhook receiver? [y/N]: ")).trim().toLowerCase();
  if (resp !== "y") {
    return {
      webhooksEnabled: false,
      publicBaseUrl: null,
      issueTrackerPath: null,
      sourceControlPath: null,
    };
  }
  // Per-adapter secrets live on the adapter config (issueTracker.config.webhookSecret,
  // sourceControl.config.webhookSecret). The init caller wires those in based on
  // webhooksEnabled — this function only handles pipeline-level webhook settings.
  const publicRaw = (
    await rl.question(
      "Public base URL for webhooks (e.g. https://hooks.example.com, blank to skip): ",
    )
  ).trim();
  const publicBaseUrl = publicRaw.length > 0 ? publicRaw.replace(/\/$/, "") : null;
  const itPath = await promptWebhookPath(rl, "issue-tracker");
  const scPath = await promptWebhookPath(rl, "source-control");
  return {
    webhooksEnabled: true,
    publicBaseUrl,
    issueTrackerPath: itPath,
    sourceControlPath: scPath,
  };
}

async function promptWebhookPath(
  rl: ReturnType<typeof createInterface>,
  kind: "issue-tracker" | "source-control",
): Promise<string | null> {
  const defaultPath = `/webhook/${kind}`;
  for (;;) {
    const resp = (await rl.question(`Webhook path for ${kind} [${defaultPath}]: `)).trim();
    if (resp.length === 0) {
      return null;
    }
    if (resp.startsWith("/") === false) {
      process.stdout.write("Path must start with '/'. Try again.\n");
      continue;
    }
    return resp;
  }
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

function writeDotEnvScaffold(
  projectDir: string,
  answers: Pick<InitAnswers, "githubAuthKind" | "issueTrackerType" | "webhooksEnabled">,
  gitignored = true,
): void {
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
    // Per-adapter webhook secrets. Issue-tracker adapter reads from
    // whichever env var matches its integration; source-control adapter
    // reads GITHUB_WEBHOOK_SECRET. github-issues reuses the GitHub secret
    // because the webhook comes from the same GitHub webhook provider.
    if (answers.issueTrackerType === "jira") {
      needed.push("JIRA_WEBHOOK_SECRET");
    }
    needed.push("GITHUB_WEBHOOK_SECRET");
  }

  if (needed.length === 0) {
    return;
  }

  const lines = [
    gitignored
      ? "# Red Queen secrets — filled in by you, gitignored."
      : "# Red Queen secrets — fill in locally and keep private.",
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

function pipelineConfig(
  baseBranch: string,
  answers: Pick<
    InitAnswers,
    | "webhooksEnabled"
    | "webhookPublicBaseUrl"
    | "webhookIssueTrackerPath"
    | "webhookSourceControlPath"
  >,
): Record<string, unknown> {
  const pipeline: Record<string, unknown> = {
    baseBranch,
  };
  if (answers.webhooksEnabled) {
    const webhooks: Record<string, unknown> = { enabled: true };
    if (answers.webhookPublicBaseUrl !== null) {
      webhooks.publicBaseUrl = answers.webhookPublicBaseUrl;
    }
    const paths: Record<string, string> = {};
    if (answers.webhookIssueTrackerPath !== null) {
      paths.issueTracker = answers.webhookIssueTrackerPath;
    }
    if (answers.webhookSourceControlPath !== null) {
      paths.sourceControl = answers.webhookSourceControlPath;
    }
    if (Object.keys(paths).length > 0) {
      webhooks.paths = paths;
    }
    pipeline.webhooks = webhooks;
  }
  return pipeline;
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
    pipeline: pipelineConfig(answers.baseBranch, answers),
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
    ".redqueen/tmp/",
    ".redqueen/*.log",
    "",
  ].join("\n");

  if (existsSync(gitignorePath) === false) {
    writeFileSync(gitignorePath, block.trimStart(), { encoding: "utf8" });
    return;
  }
  const existing = readFileSync(gitignorePath, "utf8");
  const hasBase = existing.includes(".redqueen/redqueen.db") && existing.includes(".env");
  const hasLogIgnore = existing.includes(".redqueen/*.log");
  if (hasBase && hasLogIgnore) {
    return;
  }
  if (hasBase === false) {
    appendFileSync(gitignorePath, block);
    return;
  }
  // Base block already present but predates the log rule — self-heal existing
  // installs by appending just the log rule.
  appendFileSync(gitignorePath, ["", "# Red Queen logs", ".redqueen/*.log", ""].join("\n"));
}

async function regenerateMapOnly(projectDir: string): Promise<void> {
  const configPath = join(projectDir, "redqueen.yaml");
  if (existsSync(configPath) === false) {
    throw new CliError("Cannot run --map-only without a redqueen.yaml in the current directory.");
  }
  const yaml = readFileSync(configPath, "utf8");
  const doc = parseDocument(yaml);
  const generatedAt = new Date().toISOString().slice(0, 10);
  let mapPath: string;
  let regenerated: string;
  if (doc.hasIn(["project", "repos"])) {
    if (doc.errors.length > 0) {
      throw new CliError(`Invalid YAML: ${doc.errors.map((error) => error.message).join("; ")}`);
    }
    loadDotEnv(projectDir);
    const project = doc.getIn(["project"], true);
    const projectValue: unknown = isNode(project) ? project.toJS(doc) : project;
    // Map generation needs project paths/commands, not adapter credentials or
    // unrelated settings. Keep those env references out of interpolation.
    const config = resolveProjectPaths(
      parseConfig(
        stringifyYaml({
          issueTracker: { type: "mock" },
          sourceControl: { type: "mock" },
          project: projectValue,
          pipeline: { baseBranch: doc.getIn(["pipeline", "baseBranch"]) ?? "origin/main" },
        }),
      ),
      projectDir,
    );
    validateWorkspaceRepos(config.project.directory, config.project.repos);
    mapPath = resolve(config.project.directory, ".redqueen", "codebase-map.md");
    regenerated = generateWorkspaceMap({
      rootDir: config.project.directory,
      generatedAt,
      repos: config.project.repos.map((repo) => {
        const languages = detectLanguages(repo.path);
        return { ...repo, languages, primary: languages[0]?.key ?? "blank" };
      }),
    });
  } else {
    mapPath = resolve(projectDir, ".redqueen", "codebase-map.md");
    const detected = detectLanguages(projectDir);
    const commands = readProjectCommands(yaml);
    regenerated = generateCodebaseMap({
      projectDir,
      languages: detected,
      primary: detected[0]?.key ?? "blank",
      ...commands,
      generatedAt,
    });
  }
  if (existsSync(mapPath) === false) {
    throw new CliError(`${mapPath} does not exist — run \`redqueen init\` first.`);
  }
  const existing = readFileSync(mapPath, "utf8");
  const merged = mergeRegeneratedMap(existing, regenerated);
  writeFileSync(mapPath, merged);
  process.stdout.write("Regenerated .redqueen/codebase-map.md (edit-me sections preserved).\n");
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
