import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { RedQueenConfig } from "./config.js";
import type { PhaseGraph } from "./types.js";
import type { PipelineRecord, SkillContext, Task } from "./types.js";

export interface SkillContextDeps {
  config: RedQueenConfig;
  phaseGraph: PhaseGraph;
  task: Task;
  pipelineRecord: PipelineRecord;
  phaseName: string;
  codebaseMapPath?: string | null;
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

  return {
    issueId,
    phaseName,
    phaseLabel: phase.label,
    skillName,
    buildCommands: config.project.buildCommand,
    testCommands: config.project.testCommand,
    repoOwner,
    repoName,
    branchName: pipelineRecord.branchName,
    prNumber: pipelineRecord.prNumber,
    specContent: pipelineRecord.specContent,
    priorContext: pipelineRecord.priorContext,
    iterationCount: relevantIterationCount(phaseName, pipelineRecord),
    maxIterations,
    codebaseMapPath: deps.codebaseMapPath ?? null,
    projectDir: resolve(config.project.directory),
    adapterConfig: {
      issueTracker: config.issueTracker.config,
      sourceControl: config.sourceControl.config,
    },
  };
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
