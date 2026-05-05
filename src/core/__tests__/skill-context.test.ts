import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillContext, renderSkillPrompt, resolveSkillPath } from "../skill-context.js";
import { buildPhaseGraph } from "../config.js";
import type { RedQueenConfig } from "../config.js";
import { DEFAULT_PHASES } from "../defaults.js";
import { RuntimeState } from "../runtime-state.js";
import type { PipelineRecord, Task } from "../types.js";
import { makeTestConfig } from "./fixtures/test-config.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    type: "coding",
    priority: 1,
    issueId: "PROJ-1",
    status: "ready",
    description: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    result: null,
    retryCount: 0,
    metadata: {},
    ...overrides,
  };
}

function makeRecord(overrides: Partial<PipelineRecord> = {}): PipelineRecord {
  return {
    issueId: "PROJ-1",
    currentPhase: "coding",
    branchName: null,
    prNumber: null,
    worktreePath: null,
    reviewIterations: 0,
    feedbackIterations: 0,
    specContent: null,
    priorContext: null,
    delegatorAccountId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRuntime(configOverrides: Partial<RedQueenConfig> = {}): RuntimeState {
  return new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig(configOverrides));
}

describe("buildSkillContext", () => {
  it("populates fields from config + task + record", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord({ branchName: "feature/PROJ-1", specContent: "spec body" }),
      phaseName: "coding",
    });
    expect(context.issueId).toBe("PROJ-1");
    expect(context.phaseName).toBe("coding");
    expect(context.phaseLabel).toBe("Coding");
    expect(context.skillName).toBe("coder");
    expect(context.buildCommands).toBe("npm run build");
    expect(context.testCommands).toBe("npm test");
    expect(context.repoOwner).toBe("acme");
    expect(context.repoName).toBe("app");
    expect(context.baseBranch).toBe("origin/main");
    expect(context.branchPrefix).toBe("feature/");
    expect(context.module).toBeNull();
    expect(context.branchName).toBe("feature/PROJ-1");
    expect(context.specContent).toBe("spec body");
    expect("adapterConfig" in context).toBe(false);
  });

  it("resolves branchPrefix from issueType with default fallback", () => {
    const runtime = makeRuntime();
    const bug = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord(),
      phaseName: "coding",
      issueType: "bug",
    });
    expect(bug.branchPrefix).toBe("bugfix/");

    const unknown = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord(),
      phaseName: "coding",
      issueType: "something-unknown",
    });
    expect(unknown.branchPrefix).toBe("feature/");
  });

  it("calls the module resolver when project.modules is set", () => {
    const runtime = makeRuntime({
      project: {
        buildCommand: "npm run build",
        testCommand: "npm test",
        directory: "/tmp/project",
        modules: [
          {
            name: "web",
            paths: ["src/web/**"],
            buildCommand: "npm run build:web",
            testCommandTargeted: "npm test:web",
            testCommandFull: "npm test",
          },
        ],
      },
    });
    const context = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord({ worktreePath: "/tmp/worktree" }),
      phaseName: "coding",
      resolveModule: () => ({
        buildCommand: "npm run build:web",
        testCommandTargeted: "npm test:web",
        testCommandFull: "npm test",
      }),
    });
    expect(context.module).toEqual({
      buildCommand: "npm run build:web",
      testCommandTargeted: "npm test:web",
      testCommandFull: "npm test",
    });
  });

  it("uses feedbackIterations for feedback phases", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask({ type: "code-feedback" }),
      pipelineRecord: makeRecord({ feedbackIterations: 2, reviewIterations: 5 }),
      phaseName: "code-feedback",
    });
    expect(context.iterationCount).toBe(2);
  });

  it("uses reviewIterations for review phases", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask({ type: "code-review" }),
      pipelineRecord: makeRecord({ reviewIterations: 3 }),
      phaseName: "code-review",
    });
    expect(context.iterationCount).toBe(3);
  });

  it("throws on unknown phase", () => {
    const runtime = makeRuntime();
    expect(() =>
      buildSkillContext({
        runtime,
        task: makeTask(),
        pipelineRecord: makeRecord(),
        phaseName: "unknown-phase",
      }),
    ).toThrow(/not found/);
  });
});

describe("renderSkillPrompt", () => {
  it("prepends YAML block to skill markdown", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord(),
      phaseName: "coding",
    });
    const rendered = renderSkillPrompt(context, "# Skill content");
    expect(rendered.startsWith("```yaml context\n")).toBe(true);
    expect(rendered).toContain("issueId: PROJ-1");
    expect(rendered).toContain("# Skill content");
  });
});

describe("resolveSkillPath", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-skill-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns user skill path when present", () => {
    const userDir = join(tempDir, "user");
    const skillDir = join(userDir, "coder");
    mkdirSync(skillDir, { recursive: true });
    const filePath = join(skillDir, "SKILL.md");
    writeFileSync(filePath, "# Coder");
    expect(resolveSkillPath(userDir, "coder", [])).toBe(filePath);
  });

  it("falls back to built-in when user skill missing", () => {
    const userDir = join(tempDir, "user");
    const builtIn = join(tempDir, "builtin");
    const skillDir = join(builtIn, "coder");
    mkdirSync(skillDir, { recursive: true });
    const filePath = join(skillDir, "SKILL.md");
    writeFileSync(filePath, "# Coder");
    expect(resolveSkillPath(userDir, "coder", [], builtIn)).toBe(filePath);
  });

  it("returns null when neither exists", () => {
    expect(resolveSkillPath(join(tempDir, "user"), "coder", [])).toBeNull();
  });

  it("returns null when the skill is in the disabled list, even if the file exists", () => {
    const userDir = join(tempDir, "user");
    const skillDir = join(userDir, "coder");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Coder");
    expect(resolveSkillPath(userDir, "coder", ["coder"])).toBeNull();
  });

  it("does not disable unrelated skills when disabled list has entries", () => {
    const userDir = join(tempDir, "user");
    const skillDir = join(userDir, "coder");
    mkdirSync(skillDir, { recursive: true });
    const filePath = join(skillDir, "SKILL.md");
    writeFileSync(filePath, "# Coder");
    expect(resolveSkillPath(userDir, "coder", ["tester"])).toBe(filePath);
  });
});
