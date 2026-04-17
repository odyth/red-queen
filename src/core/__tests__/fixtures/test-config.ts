import type { RedQueenConfig } from "../../config.js";
import { DEFAULT_PHASES } from "../../defaults.js";

const DEFAULT_BRANCH_PREFIXES: Record<string, string> = {
  feature: "feature/",
  bug: "bugfix/",
  task: "improvement/",
  default: "feature/",
};

export function makeTestConfig(overrides: Partial<RedQueenConfig> = {}): RedQueenConfig {
  const base: RedQueenConfig = {
    issueTracker: { type: "jira", config: {} },
    sourceControl: { type: "github", config: { owner: "acme", repo: "app" } },
    project: {
      buildCommand: "npm run build",
      testCommand: "npm test",
      directory: "/tmp/project",
    },
    pipeline: {
      pollInterval: 30,
      maxRetries: 2,
      workerTimeout: 2700,
      baseBranch: "origin/main",
      branchPrefixes: DEFAULT_BRANCH_PREFIXES,
      webhooks: { enabled: false },
      model: "opus",
      effort: "high",
      stallThresholdMs: 300000,
      reconcileInterval: 300,
    },
    phases: DEFAULT_PHASES,
    skills: { directory: ".redqueen/skills" },
    dashboard: { enabled: true, port: 4400, host: "127.0.0.1" },
    audit: { logFile: "audit.log", retentionDays: 30 },
  };
  return { ...base, ...overrides };
}
