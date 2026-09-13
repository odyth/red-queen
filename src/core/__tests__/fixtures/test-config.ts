import { legacyRepoConfig } from "../../config.js";
import type { RedQueenConfig, RepoConfig } from "../../config.js";
import { DEFAULT_PHASES } from "../../defaults.js";

const DEFAULT_BRANCH_PREFIXES: Record<string, string> = {
  feature: "feature/",
  bug: "bugfix/",
  task: "improvement/",
  default: "feature/",
};

type ProjectOverrides = Partial<Omit<RedQueenConfig["project"], "repos" | "workspaceMode">> & {
  repos?: RepoConfig[];
  workspaceMode?: boolean;
};

export type TestConfigOverrides = Omit<Partial<RedQueenConfig>, "project"> & {
  project?: ProjectOverrides;
};

// `project` overrides merge with the defaults; when they omit `repos`, the
// single legacy repo is synthesized exactly as parseConfig would.
export function makeTestConfig(overrides: TestConfigOverrides = {}): RedQueenConfig {
  const { project: projectOverrides, ...rest } = overrides;
  const base: Omit<RedQueenConfig, "project"> = {
    issueTracker: { type: "jira", config: {} },
    sourceControl: { type: "github", config: { owner: "acme", repo: "app" } },
    pipeline: {
      pollInterval: 30,
      maxRetries: 2,
      workerTimeout: 2700,
      baseBranch: "origin/main",
      branchPrefixes: DEFAULT_BRANCH_PREFIXES,
      webhooks: {
        enabled: false,
        paths: { issueTracker: "/webhook/issue-tracker", sourceControl: "/webhook/source-control" },
      },
      cost: { enabled: false, pricing: {} },
      agent: "claude-code",
      model: "opus",
      effort: "max",
      stallThresholdMs: 300000,
      reconcileInterval: 300,
      skipSpecReviewIfReady: false,
    },
    phases: DEFAULT_PHASES,
    skills: { directory: ".redqueen/skills", disabled: [] },
    dashboard: {
      enabled: true,
      port: 4400,
      host: "127.0.0.1",
      allowNonLoopback: false,
      allowedHosts: [],
    },
    audit: { logFile: "audit.log", retentionDays: 30 },
    service: {
      enabled: false,
      envFile: ".env",
      stdoutLog: ".redqueen/redqueen.out.log",
      stderrLog: ".redqueen/redqueen.err.log",
      restart: "on-failure",
    },
  };
  const merged = { ...base, ...rest };
  const project = {
    buildCommand: "npm run build",
    testCommand: "npm test",
    directory: "/tmp/project",
    ...(projectOverrides ?? {}),
  };
  const repos = project.repos ?? [
    legacyRepoConfig({
      directory: project.directory,
      buildCommand: project.buildCommand,
      testCommand: project.testCommand,
      modules: project.modules ?? [],
      sourceControlType: merged.sourceControl.type,
      sourceControlConfig: merged.sourceControl.config,
      baseBranch: merged.pipeline.baseBranch,
    }),
  ];
  return {
    ...merged,
    project: {
      ...project,
      repos,
      workspaceMode: project.workspaceMode ?? project.repos !== undefined,
    },
  };
}
