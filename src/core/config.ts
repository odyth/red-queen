import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { workspaceSkillName } from "./skill-context.js";
import { levenshtein } from "./strings.js";
import { PhaseGraph } from "./types.js";
import type { PhaseDefinition, ValidationResult } from "./types.js";
import { DEFAULT_PHASES } from "./defaults.js";

// --- Zod schemas ---

export const REPO_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const EFFORT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EffortSchema = z
  .string()
  .trim()
  .min(1, "effort must not be empty")
  .max(64, "effort must be at most 64 characters")
  .regex(
    EFFORT_RE,
    "effort must start with a letter or digit and contain only letters, digits, '.', '_' or '-'",
  );
// Service unit / plist filenames are derived from this value without
// sanitization downstream, so lock it down to a safe character set. No path
// separators, no '..' traversal — just a POSIX-ish identifier with dots.
const SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

const PhaseDefinitionSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(["automated", "human-gate"]),
    skill: z
      .string()
      .regex(
        SKILL_NAME_RE,
        "skill must be lowercase alphanumeric with hyphens (no path separators)",
      )
      .optional(),
    next: z.string().min(1),
    onFail: z.string().optional(),
    rework: z.string().optional(),
    maxIterations: z.number().int().positive().optional(),
    escalateTo: z.string().optional(),
    assignTo: z.enum(["ai", "human"]),
    iterationCounter: z.enum(["review", "feedback", "none"]).optional(),
    requiresPr: z.boolean().optional(),
    resetReviewIterationsOnPass: z.boolean().optional(),
    producesSpec: z.boolean().optional(),
    requiresSpec: z.boolean().optional(),
    skipRetryOnFailure: z.boolean().optional(),
    agent: z.enum(["claude-code", "codex"]).optional(),
    model: z.string().min(1).optional(),
    effort: EffortSchema.optional(),
  })
  .strict();

const WEBHOOK_PATH_RE = /^\/[A-Za-z0-9._~\-/]*$/;

const WebhookPathsSchema = z
  .object({
    issueTracker: z
      .string()
      .regex(WEBHOOK_PATH_RE, "webhook path must start with '/' and be URL-safe")
      .default("/webhook/issue-tracker"),
    sourceControl: z
      .string()
      .regex(WEBHOOK_PATH_RE, "webhook path must start with '/' and be URL-safe")
      .default("/webhook/source-control"),
  })
  .default({
    issueTracker: "/webhook/issue-tracker",
    sourceControl: "/webhook/source-control",
  });

const WebhooksSchema = z
  .object({
    enabled: z.boolean().default(false),
    publicBaseUrl: z.url().optional(),
    paths: WebhookPathsSchema,
  })
  .default({
    enabled: false,
    paths: {
      issueTracker: "/webhook/issue-tracker",
      sourceControl: "/webhook/source-control",
    },
  });

const DEFAULT_BRANCH_PREFIXES: Record<string, string> = {
  feature: "feature/",
  bug: "bugfix/",
  task: "improvement/",
  default: "feature/",
};

const ModelPricingSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheCreation: z.number().nonnegative(),
});

const CostSchema = z
  .object({
    enabled: z.boolean().default(false),
    pricing: z.record(z.string(), ModelPricingSchema).default({}),
  })
  .default({ enabled: false, pricing: {} });

const ProjectModuleSchema = z.object({
  name: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  buildCommand: z.string().min(1),
  testCommandTargeted: z.string().min(1).nullable().default(null),
  testCommandFull: z.string().min(1).optional(),
});

const RepoSchema = z.object({
  name: z
    .string()
    .regex(
      REPO_NAME_RE,
      "repos[].name must be lowercase alphanumeric with hyphens and start with a letter or digit",
    ),
  path: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  baseBranch: z.string().min(1).optional(),
  buildCommand: z.string(),
  testCommand: z.string(),
  modules: z.array(ProjectModuleSchema).optional(),
});

const ConfigSchema = z
  .object({
    issueTracker: z.object({
      type: z.enum(["jira", "github-issues", "mock"]),
      config: z.record(z.string(), z.unknown()).default({}),
    }),
    sourceControl: z.object({
      type: z.enum(["github", "mock"]),
      config: z.record(z.string(), z.unknown()).default({}),
    }),
    project: z.object({
      buildCommand: z.string().optional(),
      testCommand: z.string().optional(),
      directory: z.string().default("."),
      modules: z.array(ProjectModuleSchema).optional(),
      repos: z.array(RepoSchema).min(1, "project.repos must list at least one repo").optional(),
    }),
    // Zod v4 requires explicit outer .default() values for nested objects — the field-level
    // defaults only apply when the parent key is present. The duplication is intentional.
    pipeline: z
      .object({
        pollInterval: z.number().default(30),
        maxRetries: z.number().default(2),
        workerTimeout: z.number().default(2700),
        baseBranch: z.string().default("origin/main"),
        branchPrefixes: z.record(z.string(), z.string()).default(DEFAULT_BRANCH_PREFIXES),
        webhooks: WebhooksSchema,
        cost: CostSchema,
        // Which AI CLI runs workers by default; phases may override per-step.
        agent: z.enum(["claude-code", "codex"]).default("claude-code"),
        claudeBin: z.string().optional(),
        codexBin: z.string().optional(),
        // No zod default: "opus" is applied at resolution time only when the
        // resolved agent is claude-code. A schema-level default would leak an
        // Anthropic model name into codex runs.
        model: z.string().optional(),
        effort: EffortSchema.default("max"),
        stallThresholdMs: z.number().default(300000),
        reconcileInterval: z.number().default(300),
        skipSpecReviewIfReady: z.boolean().default(false),
      })
      .default({
        pollInterval: 30,
        maxRetries: 2,
        workerTimeout: 2700,
        baseBranch: "origin/main",
        branchPrefixes: DEFAULT_BRANCH_PREFIXES,
        webhooks: {
          enabled: false,
          paths: {
            issueTracker: "/webhook/issue-tracker",
            sourceControl: "/webhook/source-control",
          },
        },
        cost: { enabled: false, pricing: {} },
        agent: "claude-code",
        effort: "max",
        stallThresholdMs: 300000,
        reconcileInterval: 300,
        skipSpecReviewIfReady: false,
      }),
    phases: z.array(PhaseDefinitionSchema).default(DEFAULT_PHASES),
    skills: z
      .object({
        directory: z.string().default(".redqueen/skills"),
        disabled: z.array(z.string()).default([]),
      })
      .default({ directory: ".redqueen/skills", disabled: [] }),
    dashboard: z
      .object({
        enabled: z.boolean().default(true),
        port: z.number().default(4400),
        host: z.string().default("127.0.0.1"),
        allowNonLoopback: z.boolean().default(false),
        allowedHosts: z.array(z.string()).default([]),
      })
      .default({
        enabled: true,
        port: 4400,
        host: "127.0.0.1",
        allowNonLoopback: false,
        allowedHosts: [],
      }),
    audit: z
      .object({
        logFile: z.string().default("audit.log"),
        retentionDays: z.number().default(30),
      })
      .default({ logFile: "audit.log", retentionDays: 30 }),
    service: z
      .object({
        enabled: z.boolean().default(false),
        name: z
          .string()
          .regex(
            SERVICE_NAME_RE,
            "service.name must start with [A-Za-z0-9] and contain only letters, digits, '.', '_' or '-' (no path separators or '..')",
          )
          .optional(),
        workingDirectory: z.string().optional(),
        envFile: z.string().default(".env"),
        stdoutLog: z.string().default(".redqueen/redqueen.out.log"),
        stderrLog: z.string().default(".redqueen/redqueen.err.log"),
        restart: z.enum(["on-failure", "always", "never"]).default("on-failure"),
      })
      .default({
        enabled: false,
        envFile: ".env",
        stdoutLog: ".redqueen/redqueen.out.log",
        stderrLog: ".redqueen/redqueen.err.log",
        restart: "on-failure",
      }),
  })
  .superRefine((config, ctx) => {
    refineRepos(config, ctx);
    refineWebhooks(config, ctx);
  });

type RawConfig = z.infer<typeof ConfigSchema>;

function refineWebhooks(config: RawConfig, ctx: z.RefinementCtx): void {
  if (config.pipeline.webhooks.enabled === false) {
    return;
  }
  // Webhooks rely on HMAC signature validation. If enabled, every adapter that exposes
  // a webhook surface must carry a non-empty secret — empty strings from unset env vars
  // would otherwise silently fall through to adapters that accept unsigned payloads.
  const adapterConfigs: { path: string; config: Record<string, unknown> }[] = [
    { path: "issueTracker", config: config.issueTracker.config },
    { path: "sourceControl", config: config.sourceControl.config },
  ];
  for (const { path, config: adapterConfig } of adapterConfigs) {
    const secret = adapterConfig.webhookSecret;
    if (typeof secret !== "string" || secret.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: [path, "config", "webhookSecret"],
        message: `pipeline.webhooks.enabled is true but ${path}.config.webhookSecret is empty — set the corresponding env var or disable webhooks`,
      });
    }
  }
  if (
    config.pipeline.webhooks.paths.issueTracker === config.pipeline.webhooks.paths.sourceControl
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["pipeline", "webhooks", "paths"],
      message: `issueTracker and sourceControl webhook paths collide ("${config.pipeline.webhooks.paths.issueTracker}")`,
    });
  }
}

function refineRepos(config: RawConfig, ctx: z.RefinementCtx): void {
  const repos = config.project.repos;
  if (repos === undefined) {
    for (const key of ["buildCommand", "testCommand"] as const) {
      if (config.project[key] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["project", key],
          message: `project.${key} is required (or declare project.repos[] for workspace mode)`,
        });
      }
    }
    return;
  }
  const rejected: [string[], unknown][] = [
    [["project", "buildCommand"], config.project.buildCommand],
    [["project", "testCommand"], config.project.testCommand],
    [["project", "modules"], config.project.modules],
    [["sourceControl", "config", "owner"], config.sourceControl.config.owner],
    [["sourceControl", "config", "repo"], config.sourceControl.config.repo],
  ];
  for (const [path, value] of rejected) {
    if (value !== undefined) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `${path.join(".")} is not allowed in workspace mode — move it into project.repos[]`,
      });
    }
  }
  const seen = new Set<string>();
  const upstreams = new Map<string, string>();
  const paths = new Map<string, string>();
  repos.forEach((repo, index) => {
    if (seen.has(repo.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["project", "repos", index, "name"],
        message: `Duplicate repo name "${repo.name}"`,
      });
    }
    seen.add(repo.name);
    // Case-insensitive to match createSourceControlRegistry, which would otherwise
    // be the first thing to reject this at daemon start.
    const upstream = `${repo.owner}/${repo.repo}`.toLowerCase();
    const upstreamHolder = upstreams.get(upstream);
    if (upstreamHolder === undefined) {
      upstreams.set(upstream, repo.name);
    } else {
      ctx.addIssue({
        code: "custom",
        path: ["project", "repos", index, "repo"],
        message: `Duplicate upstream repository "${repo.owner}/${repo.repo}" — already declared by repo "${upstreamHolder}"`,
      });
    }
    // The parser is filesystem-free, so this compares normalized spellings only:
    // symlinks, case-insensitive volumes, and an absolute path aliasing a relative
    // one under a relative project.directory all get through.
    const path = normalize(
      isAbsolute(repo.path) ? repo.path : join(config.project.directory, repo.path),
    ).replace(/(?<=.)[\\/]+$/, "");
    const pathHolder = paths.get(path);
    if (pathHolder === undefined) {
      paths.set(path, repo.name);
    } else {
      ctx.addIssue({
        code: "custom",
        path: ["project", "repos", index, "path"],
        message: `Duplicate repo path "${repo.path}" — same directory as repo "${pathHolder}"`,
      });
    }
  });
  const auth = config.sourceControl.config.auth;
  const authType =
    typeof auth === "object" && auth !== null ? (auth as { type?: unknown }).type : undefined;
  if (authType === "byo-app") {
    const owners = [...new Set(repos.map((r) => r.owner))];
    if (new Set(owners.map((owner) => owner.toLowerCase())).size > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["project", "repos"],
        message: `GitHub App auth is scoped to one owner, but repos[] spans owners ${owners.join(", ")} — use token auth or split the workspace`,
      });
    }
  }
}

export type ProjectModule = z.infer<typeof ProjectModuleSchema>;

export interface RepoConfig {
  name: string;
  path: string;
  owner: string;
  repo: string;
  baseBranch: string;
  buildCommand: string;
  testCommand: string;
  modules: ProjectModule[];
}

// The resolved shape every consumer reads: repos is always populated (declared
// in workspace mode, synthesized in legacy mode) and workspaceMode records which.
export type RedQueenConfig = Omit<RawConfig, "project"> & {
  project: Omit<RawConfig["project"], "repos"> & { repos: RepoConfig[]; workspaceMode: boolean };
};

// --- Config loading ---

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// The one rule for every derived repo name (legacy synthesis, `migrate`,
// `init --add-repo`). Hand-written repos[].name values are never transformed.
export function deriveRepoName(repo: string): string {
  const derived = repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (derived === "") {
    throw new ConfigError(
      `Cannot derive a repo name from "${repo}" — it contains no [a-z0-9] characters. Set repos[].name explicitly.`,
    );
  }
  return derived;
}

const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export function interpolateEnv(
  raw: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const unresolved: string[] = [];
  const replaced = raw.replace(ENV_VAR_RE, (_match, name: string) => {
    const value = env[name];
    if (value === undefined) {
      unresolved.push(name);
      return "";
    }
    return value;
  });
  if (unresolved.length > 0) {
    const unique = [...new Set(unresolved)];
    const list = unique.map((n) => `$${n}`).join(", ");
    throw new ConfigError(
      `Config references ${list} but the environment variable${unique.length === 1 ? " is" : "s are"} not set. Did you forget to source your .env file?`,
    );
  }
  return replaced;
}

export interface LegacyRepoInput {
  directory: string;
  buildCommand: string;
  testCommand: string;
  modules: ProjectModule[];
  sourceControlType: string;
  sourceControlConfig: Record<string, unknown>;
  baseBranch: string;
}

// Legacy mode synthesizes exactly one repo from today's top-level fields.
// Shared with the test fixture so every RedQueenConfig literal agrees on the shape.
export function legacyRepoConfig(input: LegacyRepoInput): RepoConfig {
  const owner =
    typeof input.sourceControlConfig.owner === "string" ? input.sourceControlConfig.owner : "";
  const repo =
    typeof input.sourceControlConfig.repo === "string" ? input.sourceControlConfig.repo : "";
  const name = input.sourceControlType === "mock" || repo === "" ? "default" : deriveRepoName(repo);
  return {
    name,
    path: input.directory,
    owner,
    repo,
    baseBranch: input.baseBranch,
    buildCommand: input.buildCommand,
    testCommand: input.testCommand,
    modules: input.modules,
  };
}

function resolveRepos(raw: RawConfig): RedQueenConfig {
  const { repos: declared, ...project } = raw.project;
  if (declared !== undefined) {
    const repos = declared.map(
      (r): RepoConfig => ({
        name: r.name,
        path: r.path,
        owner: r.owner,
        repo: r.repo,
        baseBranch: r.baseBranch ?? raw.pipeline.baseBranch,
        buildCommand: r.buildCommand,
        testCommand: r.testCommand,
        modules: r.modules ?? [],
      }),
    );
    return { ...raw, project: { ...project, repos, workspaceMode: true } };
  }
  const repos = [
    legacyRepoConfig({
      directory: project.directory,
      buildCommand: project.buildCommand ?? "",
      testCommand: project.testCommand ?? "",
      modules: project.modules ?? [],
      sourceControlType: raw.sourceControl.type,
      sourceControlConfig: raw.sourceControl.config,
      baseBranch: raw.pipeline.baseBranch,
    }),
  ];
  return { ...raw, project: { ...project, repos, workspaceMode: false } };
}

export function parseConfig(yamlContent: string): RedQueenConfig {
  const interpolated = interpolateEnv(yamlContent);
  const parsed: unknown = parseYaml(interpolated);
  const raw = ConfigSchema.parse(parsed);
  checkDisabledSkills(raw);
  return resolveRepos(raw);
}

// parseConfig plus the filesystem checks that must stay out of the pure parser:
// every declared repo path must be a git work tree root. The synthesized legacy
// repo is exempt (project.directory may legitimately be a subdirectory today).
export function loadConfig(filePath: string): RedQueenConfig {
  const config = parseConfig(readFileSync(filePath, "utf-8"));
  if (config.project.workspaceMode === false) {
    return config;
  }
  const projectDir = resolve(dirname(filePath), config.project.directory);
  const repos = config.project.repos.map((repo) => {
    const path = resolve(projectDir, repo.path);
    if (existsSync(join(path, ".git")) === false) {
      throw new ConfigError(
        `project.repos[${repo.name}].path "${repo.path}" resolves to ${path}, which is not a git work tree root (no .git entry)`,
      );
    }
    return { ...repo, path };
  });
  return { ...config, project: { ...config.project, repos } };
}

// CLI entry points resolve project.directory relative to the config file; repo
// Workspace repo paths follow project.directory; synthesized legacy paths
// already contain project.directory and resolve directly from the config root.
export function resolveProjectPaths(config: RedQueenConfig, projectRoot: string): RedQueenConfig {
  const directory = resolve(projectRoot, config.project.directory);
  const repos = config.project.repos.map((repo) => ({
    ...repo,
    path: resolve(config.project.workspaceMode ? directory : projectRoot, repo.path),
  }));
  return { ...config, project: { ...config.project, directory, repos } };
}

function checkDisabledSkills(config: RawConfig): void {
  const disabled = new Set(config.skills.disabled);
  const workspaceMode = config.project.repos !== undefined;
  for (const phase of config.phases) {
    if (phase.skill === undefined) {
      continue;
    }
    if (disabled.has(phase.skill)) {
      throw new ConfigError(
        `Phase "${phase.name}" references skill "${phase.skill}" which is listed in skills.disabled. Remove from skills.disabled or change the phase.`,
      );
    }
    const variant = workspaceSkillName(phase.skill);
    if (workspaceMode && disabled.has(variant)) {
      throw new ConfigError(
        `Phase "${phase.name}" runs skill "${variant}" in workspace mode, which is listed in skills.disabled. Remove from skills.disabled or change the phase.`,
      );
    }
  }
}

// --- Phase graph validation ---

interface PhaseValidationError {
  phase: string;
  field: string;
  target: string;
  suggestion: string | null;
}

function findClosestMatch(target: string, candidates: string[]): string | null {
  let bestMatch: string | null = null;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const distance = levenshtein(target, candidate);
    if (distance < bestDistance && distance <= Math.max(3, Math.floor(target.length / 2))) {
      bestDistance = distance;
      bestMatch = candidate;
    }
  }

  return bestMatch;
}

export function validatePhaseGraph(phases: PhaseDefinition[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const phaseNames = new Set(phases.map((p) => p.name));
  const allNames = [...phaseNames];
  const referencedAsTarget = new Set<string>();

  // Check for duplicate phase names
  const seen = new Set<string>();
  for (const phase of phases) {
    if (seen.has(phase.name)) {
      errors.push(`Duplicate phase name: "${phase.name}"`);
    }
    seen.add(phase.name);
  }

  for (const phase of phases) {
    // Automated phases must have a skill
    if (phase.type === "automated" && phase.skill === undefined) {
      errors.push(`Phase "${phase.name}": automated phases must have a skill`);
    }

    // Human gates must have assignTo: "human"
    if (phase.type === "human-gate" && phase.assignTo !== "human") {
      errors.push(`Phase "${phase.name}": human-gate phases must have assignTo: "human"`);
    }

    // Validate all phase references
    const refs: { field: string; value: string | undefined }[] = [
      { field: "next", value: phase.next },
      { field: "onFail", value: phase.onFail },
      { field: "rework", value: phase.rework },
      { field: "escalateTo", value: phase.escalateTo },
    ];

    for (const ref of refs) {
      if (ref.value === undefined || ref.value === "done") {
        continue;
      }
      referencedAsTarget.add(ref.value);
      if (phaseNames.has(ref.value) === false) {
        const suggestion = findClosestMatch(ref.value, allNames);
        const validationError: PhaseValidationError = {
          phase: phase.name,
          field: ref.field,
          target: ref.value,
          suggestion,
        };
        const msg = suggestion
          ? `Phase "${validationError.phase}": ${validationError.field} references undefined phase "${validationError.target}". Did you mean "${suggestion}"?`
          : `Phase "${validationError.phase}": ${validationError.field} references undefined phase "${validationError.target}"`;
        errors.push(msg);
      }
    }

    // escalateTo requires maxIterations
    if (phase.escalateTo !== undefined && phase.maxIterations === undefined) {
      warnings.push(
        `Phase "${phase.name}": escalateTo is set but maxIterations is not — escalation will never trigger`,
      );
    }

    // Worker overrides only matter on phases that dispatch a worker
    if (
      phase.type === "human-gate" &&
      (phase.agent !== undefined || phase.model !== undefined || phase.effort !== undefined)
    ) {
      warnings.push(
        `Phase "${phase.name}": agent/model/effort have no effect on a human-gate phase`,
      );
    }
  }

  // Check for orphan phases (never referenced by any other phase and not the first phase)
  if (phases.length > 0) {
    const firstPhase = phases[0]?.name;
    for (const phase of phases) {
      if (phase.name !== firstPhase && referencedAsTarget.has(phase.name) === false) {
        warnings.push(`Phase "${phase.name}" is never referenced by any other phase (orphan)`);
      }
    }
  }

  return { errors, warnings };
}

export function buildPhaseGraph(phases: PhaseDefinition[]): PhaseGraph {
  const result = validatePhaseGraph(phases);
  if (result.errors.length > 0) {
    throw new Error(`Invalid phase configuration:\n${result.errors.join("\n")}`);
  }
  return new PhaseGraph(phases);
}

export { ConfigSchema, PhaseDefinitionSchema };
