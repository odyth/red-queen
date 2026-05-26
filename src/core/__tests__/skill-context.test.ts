import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSkillContext,
  buildSkillSearchDirs,
  renderSkillPrompt,
  resolveSkillPath,
} from "../skill-context.js";
import { buildPhaseGraph } from "../config.js";
import type { RedQueenConfig } from "../config.js";
import { DEFAULT_PHASES } from "../defaults.js";
import { RuntimeState } from "../runtime-state.js";
import { normalizeSpec, sha256Hex } from "../strings.js";
import type { PipelineRecord, Task } from "../types.js";
import { makeTestConfig } from "./fixtures/test-config.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    type: "coding",
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
    openQuestionCount: null,
    parsedOpenQuestionCount: null,
    filesAffectedCount: null,
    lastAiSpecHash: null,
    lastAiSpecAt: null,
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

  it("uses feedbackIterations when iterationCounter is 'feedback' (code-feedback)", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask({ type: "code-feedback" }),
      pipelineRecord: makeRecord({ feedbackIterations: 2, reviewIterations: 5 }),
      phaseName: "code-feedback",
    });
    expect(context.iterationCount).toBe(2);
  });

  it("uses reviewIterations when iterationCounter is 'review' (code-review)", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask({ type: "code-review" }),
      pipelineRecord: makeRecord({ reviewIterations: 3, feedbackIterations: 9 }),
      phaseName: "code-review",
    });
    expect(context.iterationCount).toBe(3);
  });

  it("selects the counter by config, not phase name — spec-writing uses feedbackIterations", () => {
    // The old string-match returned 0 here ("spec-writing" contains neither
    // "review" nor "feedback"). iterationCounter: "feedback" fixes it.
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask({ type: "spec-writing" }),
      pipelineRecord: makeRecord({ feedbackIterations: 2, reviewIterations: 5 }),
      phaseName: "spec-writing",
    });
    expect(context.iterationCount).toBe(2);
  });

  it("returns 0 for a phase with no iterationCounter (coding)", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask({ type: "coding" }),
      pipelineRecord: makeRecord({ feedbackIterations: 4, reviewIterations: 5 }),
      phaseName: "coding",
    });
    expect(context.iterationCount).toBe(0);
  });

  it("injects humanModifiedSpec=false for null spec content", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask({ type: "spec-writing" }),
      pipelineRecord: makeRecord({ specContent: null, lastAiSpecHash: "abc" }),
      phaseName: "spec-writing",
    });
    expect(context.humanModifiedSpec).toBe(false);
  });

  it("injects humanModifiedSpec=true when spec is present but no AI hash exists yet", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask({ type: "spec-writing" }),
      pipelineRecord: makeRecord({ specContent: "# Human draft", lastAiSpecHash: null }),
      phaseName: "spec-writing",
    });
    expect(context.humanModifiedSpec).toBe(true);
  });

  it("injects humanModifiedSpec=false when the spec matches the last AI hash", () => {
    const runtime = makeRuntime();
    const body = "# Spec\nbody";
    const context = buildSkillContext({
      runtime,
      task: makeTask({ type: "spec-writing" }),
      pipelineRecord: makeRecord({
        specContent: body,
        lastAiSpecHash: sha256Hex(normalizeSpec(body)),
      }),
      phaseName: "spec-writing",
    });
    expect(context.humanModifiedSpec).toBe(false);
  });

  it("passes lastAiSpecAt through to the context", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask({ type: "spec-writing" }),
      pipelineRecord: makeRecord({ lastAiSpecAt: "2026-05-19T12:00:00.000Z" }),
      phaseName: "spec-writing",
    });
    expect(context.lastAiSpecAt).toBe("2026-05-19T12:00:00.000Z");
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

  it("serializes humanModifiedSpec and lastAiSpecAt into the YAML block", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask({ type: "spec-writing" }),
      pipelineRecord: makeRecord({
        specContent: "# Human draft",
        lastAiSpecHash: null,
        lastAiSpecAt: "2026-05-19T12:00:00.000Z",
      }),
      phaseName: "spec-writing",
    });
    const rendered = renderSkillPrompt(context, "# body");
    expect(rendered).toContain("humanModifiedSpec: true");
    expect(rendered).toContain("lastAiSpecAt:");
    expect(rendered).toContain("2026-05-19T12:00:00.000Z");
  });

  it("strips agentskills YAML frontmatter from skill body", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord(),
      phaseName: "coding",
    });
    const body = [
      "---",
      "name: coder",
      "description: Implements a spec.",
      "metadata:",
      "  phase: coding",
      "---",
      "",
      "# Coder",
      "Body line.",
    ].join("\n");
    const rendered = renderSkillPrompt(context, body);
    expect(rendered).not.toContain("name: coder");
    expect(rendered).not.toContain("description: Implements a spec.");
    expect(rendered).toContain("# Coder");
    expect(rendered).toContain("Body line.");
  });

  it("leaves markdown unchanged when there is no frontmatter", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord(),
      phaseName: "coding",
    });
    const body = "# Skill\n\nJust body, no frontmatter.";
    const rendered = renderSkillPrompt(context, body);
    expect(rendered.endsWith(body)).toBe(true);
  });

  it("strips frontmatter with CRLF line endings", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord(),
      phaseName: "coding",
    });
    const body = [
      "---",
      "name: coder",
      "description: Implements a spec.",
      "---",
      "",
      "# Coder",
      "Body line.",
    ].join("\r\n");
    const rendered = renderSkillPrompt(context, body);
    expect(rendered).not.toContain("name: coder");
    expect(rendered).not.toContain("description: Implements a spec.");
    expect(rendered).toContain("# Coder");
    expect(rendered).toContain("Body line.");
  });

  it("leaves markdown unchanged when opening fence has no closing fence", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord(),
      phaseName: "coding",
    });
    const body = "---\nname: coder\ndescription: no closing fence here\n\n# Coder\nBody line.";
    const rendered = renderSkillPrompt(context, body);
    expect(rendered.endsWith(body)).toBe(true);
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

  function writeSkill(dir: string, name: string): string {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    const filePath = join(skillDir, "SKILL.md");
    writeFileSync(filePath, `# ${name}`);
    return filePath;
  }

  it("returns the first matching skill in the search dirs", () => {
    const userDir = join(tempDir, "user");
    const filePath = writeSkill(userDir, "coder");
    expect(resolveSkillPath([userDir], "coder", [])).toBe(filePath);
  });

  it("falls through earlier dirs to find the skill in a later dir", () => {
    const userDir = join(tempDir, "user");
    const agentsDir = join(tempDir, "agents");
    const filePath = writeSkill(agentsDir, "coder");
    expect(resolveSkillPath([userDir, agentsDir], "coder", [])).toBe(filePath);
  });

  it("respects priority order — earlier dir wins over later", () => {
    const userDir = join(tempDir, "user");
    const builtIn = join(tempDir, "builtin");
    const userFile = writeSkill(userDir, "coder");
    writeSkill(builtIn, "coder");
    expect(resolveSkillPath([userDir, builtIn], "coder", [])).toBe(userFile);
  });

  it("returns null when no dir contains the skill", () => {
    expect(resolveSkillPath([join(tempDir, "user")], "coder", [])).toBeNull();
  });

  it("returns null when the skill is in the disabled list, even if the file exists", () => {
    const userDir = join(tempDir, "user");
    writeSkill(userDir, "coder");
    expect(resolveSkillPath([userDir], "coder", ["coder"])).toBeNull();
  });

  it("does not disable unrelated skills when disabled list has entries", () => {
    const userDir = join(tempDir, "user");
    const filePath = writeSkill(userDir, "coder");
    expect(resolveSkillPath([userDir], "coder", ["tester"])).toBe(filePath);
  });

  it("loads a skill from .agents/skills/ (project-level interop)", () => {
    const projectRoot = tempDir;
    const agentsDir = join(projectRoot, ".agents", "skills");
    const filePath = writeSkill(agentsDir, "interop-skill");
    const dirs = buildSkillSearchDirs({
      userSkillsDir: ".redqueen/skills",
      projectRoot,
      homeDir: "",
    });
    expect(resolveSkillPath(dirs, "interop-skill", [])).toBe(filePath);
  });
});

describe("buildSkillSearchDirs", () => {
  it("orders configured user dir > project .agents/skills > home .agents/skills > built-in", () => {
    const dirs = buildSkillSearchDirs({
      userSkillsDir: ".redqueen/skills",
      projectRoot: "/proj",
      builtInSkillsDir: "/builtin",
      homeDir: "/home/user",
    });
    expect(dirs).toEqual([
      join("/proj", ".redqueen", "skills"),
      join("/proj", ".agents", "skills"),
      join("/home/user", ".agents", "skills"),
      "/builtin",
    ]);
  });

  it("preserves an absolute userSkillsDir without re-rooting it", () => {
    const dirs = buildSkillSearchDirs({
      userSkillsDir: "/abs/skills",
      projectRoot: "/proj",
      homeDir: "/home/user",
    });
    expect(dirs[0]).toBe("/abs/skills");
  });

  it("omits built-in when not provided", () => {
    const dirs = buildSkillSearchDirs({
      userSkillsDir: ".redqueen/skills",
      projectRoot: "/proj",
      homeDir: "/home/user",
    });
    expect(dirs).toHaveLength(3);
  });

  it("omits home .agents/skills when homeDir is empty", () => {
    const dirs = buildSkillSearchDirs({
      userSkillsDir: ".redqueen/skills",
      projectRoot: "/proj",
      homeDir: "",
    });
    expect(dirs).toEqual([
      join("/proj", ".redqueen", "skills"),
      join("/proj", ".agents", "skills"),
    ]);
  });
});
