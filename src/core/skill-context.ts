import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { ProjectModule, RedQueenConfig } from "./config.js";
import type { PhaseGraph } from "./types.js";
import type { PipelineRecord, SkillContext, SkillModuleContext, Task } from "./types.js";

export type ModuleResolver = (
  worktreePath: string | null,
  baseBranch: string,
  modules: ProjectModule[],
) => SkillModuleContext | null;

export interface SkillContextDeps {
  config: RedQueenConfig;
  phaseGraph: PhaseGraph;
  task: Task;
  pipelineRecord: PipelineRecord;
  phaseName: string;
  issueType?: string | null;
  codebaseMapPath?: string | null;
  resolveModule?: ModuleResolver;
}

export function buildSkillContext(deps: SkillContextDeps): SkillContext {
  const { config, phaseGraph, task, pipelineRecord, phaseName } = deps;
  const phase = phaseGraph.getPhase(phaseName);
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
    iterationCount: relevantIterationCount(phaseName, pipelineRecord),
    maxIterations,
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

function relevantIterationCount(phaseName: string, record: PipelineRecord): number {
  if (phaseName.includes("feedback")) {
    return record.feedbackIterations;
  }
  if (phaseName.includes("review")) {
    return record.reviewIterations;
  }
  return 0;
}

export function renderSkillPrompt(context: SkillContext, skillMarkdown: string): string {
  const yamlBlock = stringifyYaml(context, { lineWidth: 0 });
  return `\`\`\`yaml context\n${yamlBlock}\`\`\`\n\n${skillMarkdown}`;
}

export function resolveSkillPath(
  userSkillsDir: string,
  skillName: string,
  builtInSkillsDir?: string,
): string | null {
  const userCandidate = join(userSkillsDir, skillName, "SKILL.md");
  if (existsSync(userCandidate)) {
    return userCandidate;
  }
  if (builtInSkillsDir !== undefined) {
    const builtInCandidate = join(builtInSkillsDir, skillName, "SKILL.md");
    if (existsSync(builtInCandidate)) {
      return builtInCandidate;
    }
  }
  return null;
}
