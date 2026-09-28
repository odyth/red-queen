import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { ProjectModule } from "./config.js";
import type { RuntimeState } from "./runtime-state.js";
import type { StackResolution } from "./stack.js";
import type {
  PhaseDefinition,
  PipelineRecord,
  SkillContext,
  SkillContextRepo,
  SkillModuleContext,
  Task,
} from "./types.js";

export type ModuleResolver = (
  worktreePath: string | null,
  baseBranch: string,
  modules: ProjectModule[],
) => SkillModuleContext | null;

export interface SkillContextDeps {
  runtime: RuntimeState;
  task: Task;
  pipelineRecord: PipelineRecord;
  phaseName: string;
  issueType?: string | null;
  codebaseMapPath?: string | null;
  resolveModule?: ModuleResolver;
  stack?: StackResolution | null;
  // Per-repo PR bases for stacked issues, keyed by repo name.
  repoPrBases?: Record<string, string>;
}

export function buildSkillContext(deps: SkillContextDeps): SkillContext {
  const { runtime, task, pipelineRecord, phaseName } = deps;
  const config = runtime.config;
  const phase = runtime.phaseGraph.getPhase(phaseName);
  if (phase === undefined) {
    throw new Error(`Phase "${phaseName}" not found in phase graph`);
  }
  const skillName = phase.skill ?? phaseName;
  const maxIterations = phase.maxIterations ?? 3;

  const issueId = task.issueId ?? pipelineRecord.issueId;

  const branchPrefix = resolveBranchPrefix(config.pipeline.branchPrefixes, deps.issueType ?? null);

  const resolver = deps.resolveModule ?? defaultResolveModule;
  const rowsByRepo = new Map(pipelineRecord.repos.map((row) => [row.repo, row]));
  const repoEntries = config.project.repos.map((repo): SkillContextRepo => {
    const row = rowsByRepo.get(repo.name);
    const moduleContext =
      repo.modules.length > 0
        ? resolver(row?.worktreePath ?? null, repo.baseBranch, repo.modules)
        : null;
    const prBase = deps.repoPrBases?.[repo.name];
    return {
      name: repo.name,
      path: repo.path,
      baseBranch: repo.baseBranch,
      buildCommand: repo.buildCommand,
      testCommand: repo.testCommand,
      inScope: row?.inScope ?? false,
      branchName: row?.branchName ?? null,
      prNumber: row?.prNumber ?? null,
      terminalPrNumber: row?.terminalPrNumber ?? null,
      mergeCompleted: row?.mergeCompleted ?? false,
      module: moduleContext,
      ...(prBase !== undefined ? { stackPrBase: prBase } : {}),
    };
  });
  // Scalars describe the first in-scope repo so single-repo skills keep working;
  // before scope is set (spec-writing) they describe repos[0].
  const primaryIndex = Math.max(
    0,
    repoEntries.findIndex((repo) => repo.inScope),
  );
  const primary = repoEntries[primaryIndex];
  const primaryConfig = config.project.repos[primaryIndex];
  if (primary === undefined || primaryConfig === undefined) {
    throw new Error("Cannot build skill context: config.project.repos is empty");
  }

  return {
    issueId,
    phaseName,
    phaseLabel: phase.label,
    skillName,
    buildCommands: primary.buildCommand,
    testCommands: primary.testCommand,
    repoOwner: primaryConfig.owner,
    repoName: primaryConfig.repo,
    baseBranch: primary.baseBranch,
    branchPrefix,
    module: primary.module,
    branchName: primary.branchName,
    prNumber: primary.prNumber,
    specContent: pipelineRecord.specContent,
    priorContext: pipelineRecord.priorContext,
    priorPhase: pipelineRecord.priorPhase,
    iterationCount: relevantIterationCount(phase, pipelineRecord),
    maxIterations,
    codebaseMapPath: deps.codebaseMapPath ?? null,
    projectDir: resolve(config.project.directory),
    // Conditional spreads: renderSkillPrompt YAML-dumps the whole object, so
    // omitting the keys keeps legacy and non-stacked prompts byte-identical.
    ...(config.project.workspaceMode ? { repos: repoEntries } : {}),
    ...(deps.stack != null
      ? {
          stackBlockedBy: deps.stack.directBlockers.map((b) => b.id),
          stackPrBase: deps.stack.prBase,
        }
      : {}),
  };
}

export function resolveBranchPrefix(
  prefixes: Record<string, string>,
  issueType: string | null,
): string {
  if (issueType !== null) {
    const direct = prefixes[issueType];
    if (direct !== undefined && direct !== "") {
      return direct;
    }
  }
  const fallback = prefixes.default;
  if (fallback !== undefined && fallback !== "") {
    return fallback;
  }
  return "feature/";
}

function defaultResolveModule(): SkillModuleContext | null {
  // No-op default — the orchestrator injects a real resolver with git access.
  return null;
}

function relevantIterationCount(phase: PhaseDefinition, record: PipelineRecord): number {
  switch (phase.iterationCounter) {
    case "review":
      return record.reviewIterations;
    case "feedback":
      return record.feedbackIterations;
    case "none":
      return 0;
    default:
      // Legacy fallback for phases that predate iterationCounter.
      if (phase.name.includes("feedback")) {
        return record.feedbackIterations;
      }
      if (phase.name.includes("review")) {
        return record.reviewIterations;
      }
      return 0;
  }
}

export function renderSkillPrompt(context: SkillContext, skillMarkdown: string): string {
  const yamlBlock = stringifyYaml(context, { lineWidth: 0 });
  return `\`\`\`yaml context\n${yamlBlock}\`\`\`\n\n${stripFrontmatter(skillMarkdown)}`;
}

function stripFrontmatter(markdown: string): string {
  if (markdown.startsWith("---\n") === false && markdown.startsWith("---\r\n") === false) {
    return markdown;
  }
  const closingMatch = /\r?\n---\r?\n/.exec(markdown);
  if (closingMatch === null) {
    return markdown;
  }
  const end = closingMatch.index + closingMatch[0].length;
  return markdown.slice(end).replace(/^\r?\n+/, "");
}

export interface SkillSearchDirsArgs {
  userSkillsDir: string;
  projectRoot?: string;
  builtInSkillsDir?: string;
  homeDir?: string;
}

// Ordered list of directories scanned for a skill, highest priority first.
// Matches the agentskills.io implementation guide: project-level wins over
// user-level, configured client dir wins over the cross-client .agents/skills/
// convention within the same scope, bundled built-ins are the final fallback.
//
// 1. <projectRoot>/<userSkillsDir>   — configured override (default .redqueen/skills)
// 2. <projectRoot>/.agents/skills    — cross-client interop, project-level
// 3. <homeDir>/.agents/skills        — cross-client interop, user-level
// 4. <builtInSkillsDir>              — bundled fallback
export function buildSkillSearchDirs(args: SkillSearchDirsArgs): string[] {
  const projectRoot = args.projectRoot ?? process.cwd();
  const home = args.homeDir ?? homedir();
  const configured = isAbsolute(args.userSkillsDir)
    ? args.userSkillsDir
    : resolve(projectRoot, args.userSkillsDir);

  const dirs: string[] = [configured, resolve(projectRoot, ".agents", "skills")];
  if (home !== "") {
    dirs.push(join(home, ".agents", "skills"));
  }
  if (args.builtInSkillsDir !== undefined) {
    dirs.push(args.builtInSkillsDir);
  }
  return dirs;
}

export function workspaceSkillName(skillName: string): string {
  return `${skillName}-workspace`;
}

// Workspace installs run "<skill>-workspace" when any search dir has one, so a
// prompt only carries instructions for the mode it runs in. The variant outranks
// every "<skill>" file, user overrides included: those are single-repo prompts.
// Skills without a variant serve both modes.
export function resolveSkillPath(
  searchDirs: readonly string[],
  skillName: string,
  disabled: readonly string[],
  workspaceMode = false,
): string | null {
  const names = workspaceMode ? [workspaceSkillName(skillName), skillName] : [skillName];
  // A disabled variant must not fall back to the single-repo prompt.
  if (names.some((name) => disabled.includes(name))) {
    return null;
  }
  for (const name of names) {
    for (const dir of searchDirs) {
      const candidate = join(dir, name, "SKILL.md");
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
