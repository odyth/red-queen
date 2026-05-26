import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { ProjectModule } from "./config.js";
import { computeHumanModifiedSpec } from "./strings.js";
import type { RuntimeState } from "./runtime-state.js";
import type {
  PhaseDefinition,
  PipelineRecord,
  SkillContext,
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

  const scConfig = config.sourceControl.config;
  const repoOwner = typeof scConfig.owner === "string" ? scConfig.owner : "";
  const repoName = typeof scConfig.repo === "string" ? scConfig.repo : "";

  const branchPrefix = resolveBranchPrefix(config.pipeline.branchPrefixes, deps.issueType ?? null);

  const modules = config.project.modules ?? [];
  const resolver = deps.resolveModule ?? defaultResolveModule;
  const moduleContext =
    modules.length > 0
      ? resolver(pipelineRecord.worktreePath, config.pipeline.baseBranch, modules)
      : null;

  return {
    issueId,
    phaseName,
    phaseLabel: phase.label,
    skillName,
    buildCommands: config.project.buildCommand,
    testCommands: config.project.testCommand,
    repoOwner,
    repoName,
    baseBranch: config.pipeline.baseBranch,
    branchPrefix,
    module: moduleContext,
    branchName: pipelineRecord.branchName,
    prNumber: pipelineRecord.prNumber,
    specContent: pipelineRecord.specContent,
    priorContext: pipelineRecord.priorContext,
    iterationCount: relevantIterationCount(phase, pipelineRecord),
    maxIterations,
    humanModifiedSpec: computeHumanModifiedSpec(
      pipelineRecord.specContent,
      pipelineRecord.lastAiSpecHash,
    ),
    lastAiSpecAt: pipelineRecord.lastAiSpecAt,
    codebaseMapPath: deps.codebaseMapPath ?? null,
    projectDir: resolve(config.project.directory),
  };
}

function resolveBranchPrefix(prefixes: Record<string, string>, issueType: string | null): string {
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
    case undefined:
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

export function resolveSkillPath(
  searchDirs: readonly string[],
  skillName: string,
  disabled: readonly string[],
): string | null {
  if (disabled.includes(skillName)) {
    return null;
  }
  for (const dir of searchDirs) {
    const candidate = join(dir, skillName, "SKILL.md");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
