import { z } from "zod";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { PhaseGraph } from "./types.js";
import type { PhaseDefinition, ValidationResult } from "./types.js";
import { DEFAULT_PHASES } from "./defaults.js";

// --- Zod schemas ---

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const PhaseDefinitionSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["automated", "human-gate"]),
  skill: z
    .string()
    .regex(SKILL_NAME_RE, "skill must be lowercase alphanumeric with hyphens (no path separators)")
    .optional(),
  next: z.string().min(1),
  onFail: z.string().optional(),
  rework: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
  escalateTo: z.string().optional(),
  assignTo: z.enum(["ai", "human"]),
  priority: z.number().int().min(0).optional(),
});

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
      buildCommand: z.string(),
      testCommand: z.string(),
      directory: z.string().default("."),
      modules: z
        .array(
          z.object({
            name: z.string().min(1),
            paths: z.array(z.string().min(1)).min(1),
            buildCommand: z.string().min(1),
            testCommandTargeted: z.string().min(1).nullable().default(null),
            testCommandFull: z.string().min(1).optional(),
          }),
        )
        .optional(),
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
        claudeBin: z.string().optional(),
        model: z.string().default("opus"),
        effort: z.string().default("high"),
        stallThresholdMs: z.number().default(300000),
        reconcileInterval: z.number().default(300),
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
        model: "opus",
        effort: "high",
        stallThresholdMs: 300000,
        reconcileInterval: 300,
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
      })
      .default({ enabled: true, port: 4400, host: "127.0.0.1" }),
    audit: z
      .object({
        logFile: z.string().default("audit.log"),
        retentionDays: z.number().default(30),
      })
      .default({ logFile: "audit.log", retentionDays: 30 }),
  })
  .superRefine((config, ctx) => {
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
  });

export type RedQueenConfig = z.infer<typeof ConfigSchema>;

export type ProjectModule = NonNullable<RedQueenConfig["project"]["modules"]>[number];

// --- Config loading ---

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
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

export function loadConfig(filePath: string): RedQueenConfig {
  const raw = readFileSync(filePath, "utf-8");
  const interpolated = interpolateEnv(raw);
  const parsed: unknown = parseYaml(interpolated);
  const config = ConfigSchema.parse(parsed);
  checkDisabledSkills(config);
  return config;
}

export function parseConfig(yamlContent: string): RedQueenConfig {
  const interpolated = interpolateEnv(yamlContent);
  const parsed: unknown = parseYaml(interpolated);
  const config = ConfigSchema.parse(parsed);
  checkDisabledSkills(config);
  return config;
}

function checkDisabledSkills(config: RedQueenConfig): void {
  const disabled = new Set(config.skills.disabled);
  for (const phase of config.phases) {
    if (phase.skill !== undefined && disabled.has(phase.skill)) {
      throw new ConfigError(
        `Phase "${phase.name}" references skill "${phase.skill}" which is listed in skills.disabled. Remove from skills.disabled or change the phase.`,
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

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use flat array for the DP table — avoids non-null assertions on nested access
  const dp = new Array<number>((m + 1) * (n + 1)).fill(0);
  const idx = (i: number, j: number): number => i * (n + 1) + j;

  for (let i = 0; i <= m; i++) {
    dp[idx(i, 0)] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[idx(0, j)] = j;
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (dp[idx(i - 1, j)] ?? 0) + 1;
      const ins = (dp[idx(i, j - 1)] ?? 0) + 1;
      const sub = (dp[idx(i - 1, j - 1)] ?? 0) + cost;
      dp[idx(i, j)] = Math.min(del, ins, sub);
    }
  }

  return dp[idx(m, n)] ?? 0;
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
