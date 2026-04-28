import { describe, it, expect } from "vitest";
import { parseConfig, validatePhaseGraph, buildPhaseGraph } from "../config.js";
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
    expect(config.dashboard.enabled).toBe(true);
    expect(config.dashboard.port).toBe(4400);
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
dashboard:
  port: 8080
`;
    const config = parseConfig(yaml);
    expect(config.issueTracker.type).toBe("github-issues");
    expect(config.project.directory).toBe("./src");
    expect(config.pipeline.pollInterval).toBe(60);
    expect(config.pipeline.baseBranch).toBe("origin/develop");
    expect(config.dashboard.port).toBe(8080);
  });

  it("rejects missing required fields", () => {
    expect(() => parseConfig("sourceControl:\n  type: github")).toThrow();
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
});
