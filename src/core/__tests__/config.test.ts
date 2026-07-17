import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  loadConfig,
  parseConfig,
  validatePhaseGraph,
  buildPhaseGraph,
} from "../config.js";
import { DEFAULT_PHASES } from "../defaults.js";
import type { PhaseDefinition } from "../types.js";

describe("parseConfig", () => {
  const minimalYaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
`;

  it("parses minimal config with defaults applied", () => {
    const config = parseConfig(minimalYaml);
    expect(config.issueTracker.type).toBe("jira");
    expect(config.sourceControl.type).toBe("github");
    expect(config.project.buildCommand).toBe("npm run build");
    expect(config.project.testCommand).toBe("npm test");
    expect(config.project.directory).toBe(".");
    expect(config.pipeline.pollInterval).toBe(30);
    expect(config.pipeline.maxRetries).toBe(2);
    expect(config.pipeline.workerTimeout).toBe(2700);
    expect(config.pipeline.baseBranch).toBe("origin/main");
    expect(config.pipeline.webhooks.enabled).toBe(false);
    expect(config.pipeline.skipSpecReviewIfReady).toBe(false);
    expect(config.dashboard.enabled).toBe(true);
    expect(config.dashboard.port).toBe(4400);
    expect(config.dashboard.allowNonLoopback).toBe(false);
    expect(config.dashboard.allowedHosts).toEqual([]);
    expect(config.audit.logFile).toBe("audit.log");
    expect(config.audit.retentionDays).toBe(30);
    expect(config.skills.directory).toBe(".redqueen/skills");
    expect(config.phases).toEqual(DEFAULT_PHASES);
  });

  it("allows overriding defaults", () => {
    const yaml = `
issueTracker:
  type: github-issues
sourceControl:
  type: github
project:
  buildCommand: "dotnet build"
  testCommand: "dotnet test"
  directory: "./src"
pipeline:
  pollInterval: 60
  baseBranch: origin/develop
  skipSpecReviewIfReady: true
dashboard:
  port: 8080
`;
    const config = parseConfig(yaml);
    expect(config.issueTracker.type).toBe("github-issues");
    expect(config.project.directory).toBe("./src");
    expect(config.pipeline.pollInterval).toBe(60);
    expect(config.pipeline.baseBranch).toBe("origin/develop");
    expect(config.pipeline.skipSpecReviewIfReady).toBe(true);
    expect(config.dashboard.port).toBe(8080);
  });

  it("rejects missing required fields", () => {
    expect(() => parseConfig("sourceControl:\n  type: github")).toThrow();
  });

  it("defaults to the claude-code agent with no model", () => {
    const config = parseConfig(minimalYaml);
    expect(config.pipeline.agent).toBe("claude-code");
    expect(config.pipeline.model).toBeUndefined();
    expect(config.pipeline.effort).toBe("high");
    expect(config.pipeline.codexBin).toBeUndefined();
  });

  it("parses a codex master agent", () => {
    const yaml = `${minimalYaml}pipeline:
  agent: codex
  codexBin: /usr/local/bin/codex
`;
    const config = parseConfig(yaml);
    expect(config.pipeline.agent).toBe("codex");
    expect(config.pipeline.codexBin).toBe("/usr/local/bin/codex");
  });

  it("rejects an unknown agent", () => {
    const yaml = `${minimalYaml}pipeline:
  agent: gemini
`;
    expect(() => parseConfig(yaml)).toThrow();
  });

  it("parses per-phase agent/model/effort overrides under the strict phase schema", () => {
    const yaml = `${minimalYaml}phases:
  - name: coding
    label: Coding
    type: automated
    skill: coder
    next: done
    assignTo: ai
    agent: codex
    model: gpt-5.3-codex
    effort: xhigh
`;
    const config = parseConfig(yaml);
    expect(config.phases[0]?.agent).toBe("codex");
    expect(config.phases[0]?.model).toBe("gpt-5.3-codex");
    expect(config.phases[0]?.effort).toBe("xhigh");
  });

  it("rejects an invalid per-phase effort", () => {
    const yaml = `${minimalYaml}phases:
  - name: coding
    label: Coding
    type: automated
    skill: coder
    next: done
    assignTo: ai
    effort: turbo
`;
    expect(() => parseConfig(yaml)).toThrow();
  });

  it("accepts skipRetryOnFailure on a YAML-defined phase", () => {
    const yaml = `${minimalYaml}phases:
  - name: code-review
    label: Code Review
    type: automated
    skill: reviewer
    next: done
    assignTo: ai
    skipRetryOnFailure: true
`;
    const config = parseConfig(yaml);
    expect(config.phases[0]?.skipRetryOnFailure).toBe(true);
  });

  it("rejects invalid issueTracker type", () => {
    const yaml = `
issueTracker:
  type: gitlab
sourceControl:
  type: github
project:
  buildCommand: "make"
  testCommand: "make test"
`;
    expect(() => parseConfig(yaml)).toThrow();
  });

  it("passes adapter-specific config through as opaque record", () => {
    const yaml = `
issueTracker:
  type: jira
  config:
    cloudId: "abc-123"
    customFields:
      aiPhase: "customfield_10158"
sourceControl:
  type: github
  config:
    appId: 12345
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
`;
    const config = parseConfig(yaml);
    expect(config.issueTracker.config).toEqual({
      cloudId: "abc-123",
      customFields: { aiPhase: "customfield_10158" },
    });
    expect(config.sourceControl.config).toEqual({ appId: 12345 });
  });

  it("rejects webhooks.enabled when adapter secrets are missing or empty", () => {
    const yaml = `
issueTracker:
  type: github-issues
  config:
    owner: o
    repo: r
sourceControl:
  type: github
  config:
    owner: o
    repo: r
    webhookSecret: ""
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
pipeline:
  webhooks:
    enabled: true
`;
    expect(() => parseConfig(yaml)).toThrow(/webhookSecret is empty/);
  });

  it("accepts webhooks.enabled when every adapter has a non-empty secret", () => {
    const yaml = `
issueTracker:
  type: github-issues
  config:
    owner: o
    repo: r
    webhookSecret: "shh"
sourceControl:
  type: github
  config:
    owner: o
    repo: r
    webhookSecret: "shh"
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
pipeline:
  webhooks:
    enabled: true
`;
    const config = parseConfig(yaml);
    expect(config.pipeline.webhooks.enabled).toBe(true);
    expect(config.pipeline.webhooks.paths.issueTracker).toBe("/webhook/issue-tracker");
    expect(config.pipeline.webhooks.paths.sourceControl).toBe("/webhook/source-control");
  });

  it("accepts custom webhook paths and publicBaseUrl", () => {
    const yaml = `
issueTracker:
  type: github-issues
  config:
    owner: o
    repo: r
    webhookSecret: "shh"
sourceControl:
  type: github
  config:
    owner: o
    repo: r
    webhookSecret: "shh"
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
pipeline:
  webhooks:
    enabled: true
    publicBaseUrl: https://hooks.example.com
    paths:
      issueTracker: /webhook/jira
      sourceControl: /webhook/github
`;
    const config = parseConfig(yaml);
    expect(config.pipeline.webhooks.paths.issueTracker).toBe("/webhook/jira");
    expect(config.pipeline.webhooks.paths.sourceControl).toBe("/webhook/github");
    expect(config.pipeline.webhooks.publicBaseUrl).toBe("https://hooks.example.com");
  });

  it("rejects webhook paths that do not start with '/'", () => {
    const yaml = `
issueTracker:
  type: github-issues
  config:
    owner: o
    repo: r
    webhookSecret: "shh"
sourceControl:
  type: github
  config:
    owner: o
    repo: r
    webhookSecret: "shh"
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
pipeline:
  webhooks:
    enabled: true
    paths:
      issueTracker: webhook/jira
`;
    expect(() => parseConfig(yaml)).toThrow(/webhook path must start with/);
  });

  it("rejects colliding webhook paths", () => {
    const yaml = `
issueTracker:
  type: github-issues
  config:
    owner: o
    repo: r
    webhookSecret: "shh"
sourceControl:
  type: github
  config:
    owner: o
    repo: r
    webhookSecret: "shh"
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
pipeline:
  webhooks:
    enabled: true
    paths:
      issueTracker: /webhook/same
      sourceControl: /webhook/same
`;
    expect(() => parseConfig(yaml)).toThrow(/collide/);
  });

  it("rejects invalid publicBaseUrl", () => {
    const yaml = `
issueTracker:
  type: github-issues
  config:
    owner: o
    repo: r
    webhookSecret: "shh"
sourceControl:
  type: github
  config:
    owner: o
    repo: r
    webhookSecret: "shh"
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
pipeline:
  webhooks:
    enabled: true
    publicBaseUrl: not-a-url
`;
    expect(() => parseConfig(yaml)).toThrow();
  });

  it("parses custom phases", () => {
    const yaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
phases:
  - name: writing
    label: Writing
    type: automated
    skill: writer
    next: review
    assignTo: ai
  - name: review
    label: Review
    type: human-gate
    next: done
    assignTo: human
`;
    const config = parseConfig(yaml);
    expect(config.phases).toHaveLength(2);
    expect(config.phases[0]?.name).toBe("writing");
    expect(config.phases[1]?.name).toBe("review");
  });

  it("defaults the service block with expected values", () => {
    const yaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
`;
    const config = parseConfig(yaml);
    expect(config.service.enabled).toBe(false);
    expect(config.service.envFile).toBe(".env");
    expect(config.service.stdoutLog).toBe(".redqueen/redqueen.out.log");
    expect(config.service.stderrLog).toBe(".redqueen/redqueen.err.log");
    expect(config.service.restart).toBe("on-failure");
    expect(config.service.name).toBeUndefined();
  });

  it("rejects unknown service.restart values", () => {
    const yaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
service:
  restart: whenever
`;
    expect(() => parseConfig(yaml)).toThrow();
  });

  it("accepts custom service overrides", () => {
    const yaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
service:
  enabled: true
  name: custom.redqueen
  envFile: secrets/.env
  restart: always
`;
    const config = parseConfig(yaml);
    expect(config.service.enabled).toBe(true);
    expect(config.service.name).toBe("custom.redqueen");
    expect(config.service.envFile).toBe("secrets/.env");
    expect(config.service.restart).toBe("always");
  });

  it("rejects service.name path-traversal payloads", () => {
    const evilNames = [
      "../../../etc/passwd",
      "../.ssh/authorized_keys",
      "foo/bar",
      "foo\\bar",
      ".leading-dot",
      "has space",
      "", // empty string is not a valid override either
    ];
    for (const name of evilNames) {
      const yaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
service:
  name: "${name.replace(/"/g, '\\"')}"
`;
      expect(() => parseConfig(yaml), `expected rejection for name="${name}"`).toThrow();
    }
  });

  it("accepts safe service.name overrides", () => {
    const safeNames = [
      "redqueen",
      "com.example.redqueen",
      "sh.redqueen.ab12",
      "my_service",
      "a-b.c_d.e-f",
    ];
    for (const name of safeNames) {
      const yaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
service:
  name: ${name}
`;
      const config = parseConfig(yaml);
      expect(config.service.name).toBe(name);
    }
  });

  it("defaults skills.disabled to an empty array", () => {
    const yaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
`;
    const config = parseConfig(yaml);
    expect(config.skills.disabled).toEqual([]);
  });

  it("loads fine when skills.disabled references a skill no phase uses", () => {
    const yaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
skills:
  disabled:
    - unused-skill
`;
    const config = parseConfig(yaml);
    expect(config.skills.disabled).toEqual(["unused-skill"]);
  });

  it("parseConfig rejects configs where a phase references a disabled skill", () => {
    const yaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
skills:
  disabled:
    - coder
`;
    expect(() => parseConfig(yaml)).toThrow(ConfigError);
    expect(() => parseConfig(yaml)).toThrow(/skills\.disabled/);
  });

  it("loadConfig rejects configs where a phase references a disabled skill", () => {
    const yaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
skills:
  disabled:
    - coder
`;
    const dir = mkdtempSync(join(tmpdir(), "rq-cfg-disabled-"));
    const file = join(dir, "redqueen.yaml");
    writeFileSync(file, yaml);
    try {
      expect(() => loadConfig(file)).toThrow(ConfigError);
      expect(() => loadConfig(file)).toThrow(/skills\.disabled/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a phase that still carries a priority field", () => {
    const yaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
phases:
  - name: legacy
    label: Legacy
    type: automated
    skill: coder
    next: done
    assignTo: ai
    priority: 0
`;
    expect(() => parseConfig(yaml)).toThrow();
  });
});

describe("validatePhaseGraph", () => {
  it("validates default phases with zero errors", () => {
    const result = validatePhaseGraph(DEFAULT_PHASES);
    expect(result.errors).toHaveLength(0);
  });

  it("catches undefined phase references", () => {
    const phases: PhaseDefinition[] = [
      {
        name: "coding",
        label: "Coding",
        type: "automated",
        skill: "coder",
        next: "nonexistent",
        assignTo: "ai",
      },
    ];
    const result = validatePhaseGraph(phases);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("nonexistent");
  });

  it("suggests typo corrections", () => {
    const phases: PhaseDefinition[] = [
      {
        name: "spec-writing",
        label: "Spec Writing",
        type: "automated",
        skill: "writer",
        next: "spec-reveiw", // typo
        assignTo: "ai",
      },
      {
        name: "spec-review",
        label: "Spec Review",
        type: "human-gate",
        next: "done",
        assignTo: "human",
      },
    ];
    const result = validatePhaseGraph(phases);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Did you mean "spec-review"');
  });

  it("catches automated phases without skill", () => {
    const phases: PhaseDefinition[] = [
      {
        name: "coding",
        label: "Coding",
        type: "automated",
        next: "done",
        assignTo: "ai",
      },
    ];
    const result = validatePhaseGraph(phases);
    expect(result.errors).toContain('Phase "coding": automated phases must have a skill');
  });

  it("warns when a human-gate phase carries worker overrides", () => {
    const phases: PhaseDefinition[] = [
      {
        name: "human-review",
        label: "Human Review",
        type: "human-gate",
        next: "done",
        assignTo: "human",
        agent: "codex",
      },
    ];
    const result = validatePhaseGraph(phases);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toContain(
      'Phase "human-review": agent/model/effort have no effect on a human-gate phase',
    );
  });

  it("catches human-gate phases with assignTo: ai", () => {
    const phases: PhaseDefinition[] = [
      {
        name: "review",
        label: "Review",
        type: "human-gate",
        next: "done",
        assignTo: "ai",
      },
    ];
    const result = validatePhaseGraph(phases);
    expect(result.errors).toContain(
      'Phase "review": human-gate phases must have assignTo: "human"',
    );
  });

  it("catches duplicate phase names", () => {
    const phases: PhaseDefinition[] = [
      {
        name: "coding",
        label: "Coding",
        type: "automated",
        skill: "coder",
        next: "done",
        assignTo: "ai",
      },
      {
        name: "coding",
        label: "Coding Again",
        type: "automated",
        skill: "coder2",
        next: "done",
        assignTo: "ai",
      },
    ];
    const result = validatePhaseGraph(phases);
    expect(result.errors).toContain('Duplicate phase name: "coding"');
  });

  it("warns about orphan phases", () => {
    const phases: PhaseDefinition[] = [
      {
        name: "coding",
        label: "Coding",
        type: "automated",
        skill: "coder",
        next: "done",
        assignTo: "ai",
      },
      {
        name: "orphan",
        label: "Orphan",
        type: "automated",
        skill: "something",
        next: "done",
        assignTo: "ai",
      },
    ];
    const result = validatePhaseGraph(phases);
    expect(result.warnings.some((w) => w.includes("orphan"))).toBe(true);
  });

  it("warns about escalateTo without maxIterations", () => {
    const phases: PhaseDefinition[] = [
      {
        name: "review",
        label: "Review",
        type: "automated",
        skill: "reviewer",
        next: "done",
        escalateTo: "blocked",
        assignTo: "ai",
      },
      {
        name: "blocked",
        label: "Blocked",
        type: "human-gate",
        next: "done",
        assignTo: "human",
      },
    ];
    const result = validatePhaseGraph(phases);
    expect(
      result.warnings.some((w) => w.includes("escalateTo") && w.includes("maxIterations")),
    ).toBe(true);
  });

  it("accepts 'done' as valid next target", () => {
    const phases: PhaseDefinition[] = [
      {
        name: "final",
        label: "Final",
        type: "human-gate",
        next: "done",
        assignTo: "human",
      },
    ];
    const result = validatePhaseGraph(phases);
    expect(result.errors).toHaveLength(0);
  });
});

describe("buildPhaseGraph", () => {
  it("builds graph from valid phases", () => {
    const graph = buildPhaseGraph(DEFAULT_PHASES);
    expect(graph.size).toBe(DEFAULT_PHASES.length);
    expect(graph.getPhase("coding")?.skill).toBe("coder");
    expect(graph.getNext("coding")).toBe("code-review");
    expect(graph.isHumanGate("spec-review")).toBe(true);
    expect(graph.isHumanGate("coding")).toBe(false);
    expect(graph.getAutomatedPhases().length).toBeGreaterThan(0);
    expect(graph.getHumanGates().length).toBeGreaterThan(0);
  });

  it("throws on invalid phases", () => {
    const phases: PhaseDefinition[] = [
      {
        name: "bad",
        label: "Bad",
        type: "automated",
        next: "nonexistent",
        assignTo: "ai",
      },
    ];
    expect(() => buildPhaseGraph(phases)).toThrow("Invalid phase configuration");
  });

  it("supports all lookup methods", () => {
    const graph = buildPhaseGraph(DEFAULT_PHASES);
    expect(graph.has("coding")).toBe(true);
    expect(graph.has("nonexistent")).toBe(false);
    expect(graph.getOnFail("code-review")).toBe("coding");
    expect(graph.getRework("human-review")).toBe("code-feedback");
    expect(graph.getEscalateTo("code-review")).toBe("human-review");
    expect(graph.getPhaseNames()).toContain("spec-writing");
    expect(graph.getAllPhases()).toHaveLength(DEFAULT_PHASES.length);
  });

  it("getEntryPhases returns phases never referenced as targets", () => {
    const graph = buildPhaseGraph(DEFAULT_PHASES);
    const entryNames = graph.getEntryPhases().map((p) => p.name);
    expect(entryNames).toContain("spec-writing");
    expect(entryNames).not.toContain("coding");
    expect(entryNames).not.toContain("code-review");
    expect(entryNames).not.toContain("spec-review");
  });

  it("DEFAULT_PHASES includes spec-awaiting-info as a human-gate that exits to spec-writing", () => {
    const phase = DEFAULT_PHASES.find((p) => p.name === "spec-awaiting-info");
    expect(phase).toBeDefined();
    expect(phase?.type).toBe("human-gate");
    expect(phase?.next).toBe("spec-writing");
    expect(phase?.assignTo).toBe("human");
  });

  it("spec-writing.onFail routes to spec-awaiting-info", () => {
    const phase = DEFAULT_PHASES.find((p) => p.name === "spec-writing");
    expect(phase?.onFail).toBe("spec-awaiting-info");
  });

  it("spec-awaiting-info is NOT an entry phase (onFail wiring keeps it out)", () => {
    const graph = buildPhaseGraph(DEFAULT_PHASES);
    const entryNames = graph.getEntryPhases().map((p) => p.name);
    expect(entryNames).not.toContain("spec-awaiting-info");
  });
});

describe("pipeline.cost", () => {
  const baseYamlHeader = `
issueTracker:
  type: jira
  config:
    baseUrl: "https://example.atlassian.net"
    email: "bot@example.com"
    apiToken: "secret"
    projectKey: "TEST"
    customFields:
      phase: "customfield_1"
      spec: "customfield_2"
    phaseMapping:
      coding:
        optionId: "10001"
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
`;

  it("defaults cost.enabled to false and pricing to {}", () => {
    const config = parseConfig(baseYamlHeader);
    expect(config.pipeline.cost.enabled).toBe(false);
    expect(config.pipeline.cost.pricing).toEqual({});
  });

  it("accepts cost.enabled=true on Jira without custom field IDs (marker comment path)", () => {
    const yaml = `${baseYamlHeader}
pipeline:
  cost:
    enabled: true
`;
    const config = parseConfig(yaml);
    expect(config.pipeline.cost.enabled).toBe(true);
  });

  it("accepts cost.enabled=true on Jira with pricing overrides", () => {
    const yaml = `${baseYamlHeader}
pipeline:
  cost:
    enabled: true
    pricing:
      opus:
        input: 15
        output: 75
        cacheRead: 1.5
        cacheCreation: 18.75
`;
    const config = parseConfig(yaml);
    expect(config.pipeline.cost.enabled).toBe(true);
    expect(config.pipeline.cost.pricing.opus?.input).toBe(15);
  });

  it("accepts cost.enabled=true on github-issues without custom fields (marker comment path)", () => {
    const yaml = `
issueTracker:
  type: github-issues
  config:
    owner: "acme"
    repo: "app"
    auth:
      type: pat
      token: "ghp_xxx"
sourceControl:
  type: github
  config:
    owner: "acme"
    repo: "app"
    auth:
      type: pat
      token: "ghp_xxx"
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
pipeline:
  cost:
    enabled: true
`;
    const config = parseConfig(yaml);
    expect(config.pipeline.cost.enabled).toBe(true);
  });
});

describe("shipped example configs", () => {
  // Guards against config/example drift: every shipped config must parse under
  // the current schema. Examples reference env vars, so stub them; loadConfig
  // does not read privateKeyPath, so a non-existent PEM path is fine here.
  const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../examples");
  const stubEnv: Record<string, string> = {
    JIRA_TOKEN: "test-token",
    JIRA_WEBHOOK_SECRET: "test-jira-secret",
    GITHUB_PAT: "ghp_test",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_INSTALLATION_ID: "7890",
    GITHUB_WEBHOOK_SECRET: "test-gh-secret",
  };

  function findConfigYaml(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...findConfigYaml(full));
      } else if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) {
        found.push(full);
      }
    }
    return found;
  }

  const exampleFiles = findConfigYaml(examplesDir);

  it("ships at least one example config", () => {
    expect(exampleFiles.length).toBeGreaterThan(0);
  });

  it.each(exampleFiles)("loads %s without error", (file) => {
    for (const [key, value] of Object.entries(stubEnv)) {
      vi.stubEnv(key, value);
    }
    try {
      expect(() => loadConfig(file)).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
