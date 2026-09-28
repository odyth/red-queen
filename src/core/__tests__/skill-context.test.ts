import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSkillContext,
  buildSkillSearchDirs,
  renderSkillPrompt,
  resolveSkillPath,
} from "../skill-context.js";
import type { ModuleResolver } from "../skill-context.js";
import { buildPhaseGraph } from "../config.js";
import type { RepoConfig } from "../config.js";
import type { TestConfigOverrides } from "./fixtures/test-config.js";
import { DEFAULT_PHASES } from "../defaults.js";
import { RuntimeState } from "../runtime-state.js";
import type { PhaseDefinition, PipelineRecord, PipelineRepoRecord, Task } from "../types.js";
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
    priorPhase: null,
    branchName: null,
    prNumber: null,
    prBaseBranch: null,
    terminalPrNumber: null,
    repos: [],
    worktreePath: null,
    reviewIterations: 0,
    feedbackIterations: 0,
    specContent: null,
    priorContext: null,
    delegatorAccountId: null,
    openQuestionCount: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRuntime(configOverrides: TestConfigOverrides = {}): RuntimeState {
  return new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig(configOverrides));
}

function repoCfg(name: string, overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name,
    path: `/srv/ws/${name}`,
    owner: "acme",
    repo: name,
    baseBranch: "origin/main",
    buildCommand: `build ${name}`,
    testCommand: `test ${name}`,
    modules: [],
    ...overrides,
  };
}

function repoRow(repo: string, overrides: Partial<PipelineRepoRecord> = {}): PipelineRepoRecord {
  return {
    issueId: "PROJ-1",
    repo,
    inScope: true,
    branchName: null,
    prNumber: null,
    prBaseBranch: null,
    terminalPrNumber: null,
    mergeCompleted: false,
    worktreePath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildSkillContext", () => {
  it("populates fields from config + task + record", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord({
        branchName: "feature/PROJ-1",
        repos: [repoRow("app", { branchName: "feature/PROJ-1" })],
        specContent: "spec body",
      }),
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
      pipelineRecord: makeRecord({
        worktreePath: "/tmp/worktree",
        repos: [repoRow("app", { worktreePath: "/tmp/worktree" })],
      }),
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

  it("uses reviewIterations for coding via the iterationCounter field", () => {
    // coding's name matches neither "review" nor "feedback", so this relies on
    // the explicit iterationCounter: "review" rather than the legacy fallback.
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask({ type: "coding" }),
      pipelineRecord: makeRecord({ reviewIterations: 1, feedbackIterations: 7 }),
      phaseName: "coding",
    });
    expect(context.iterationCount).toBe(1);
  });

  it("iterationCounter 'none' forces iterationCount to 0", () => {
    const phases: PhaseDefinition[] = [
      ...DEFAULT_PHASES,
      {
        name: "noner",
        label: "Noner",
        type: "automated",
        skill: "coder",
        next: "done",
        assignTo: "ai",
        iterationCounter: "none",
      },
    ];
    const runtime = new RuntimeState(buildPhaseGraph(phases), makeTestConfig());
    const context = buildSkillContext({
      runtime,
      task: makeTask({ type: "noner" }),
      pipelineRecord: makeRecord({ reviewIterations: 9, feedbackIterations: 9 }),
      phaseName: "noner",
    });
    expect(context.iterationCount).toBe(0);
  });

  it("carries priorPhase into the context", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord({ priorPhase: "code-review" }),
      phaseName: "coding",
    });
    expect(context.priorPhase).toBe("code-review");
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

  it("adds stack fields when a stack resolution is passed", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord(),
      phaseName: "coding",
      stack: {
        ok: true,
        directBlockers: [{ id: "PROJ-9", closed: false }],
        mergeBranches: ["feature/PROJ-9"],
        prBase: "feature/PROJ-9",
        repos: { app: { mergeBranches: ["feature/PROJ-9"], prBase: "feature/PROJ-9" } },
        unsatisfied: [],
        cycle: null,
        problems: [],
      },
    });
    expect(context.stackBlockedBy).toEqual(["PROJ-9"]);
    expect(context.stackPrBase).toBe("feature/PROJ-9");
  });

  it("omits stack keys entirely for non-stacked issues — prompt stays byte-identical", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord(),
      phaseName: "coding",
    });
    expect("stackBlockedBy" in context).toBe(false);
    expect("stackPrBase" in context).toBe(false);
    const rendered = renderSkillPrompt(context, "# Skill");
    expect(rendered).not.toContain("stack");
  });
});

describe("buildSkillContext workspace mode", () => {
  it("omits repository keys entirely from legacy prompts", () => {
    const context = buildSkillContext({
      runtime: makeRuntime(),
      task: makeTask(),
      pipelineRecord: makeRecord({
        branchName: "feature/PROJ-1",
        prNumber: 42,
        repos: [repoRow("app", { branchName: "feature/PROJ-1", prNumber: 42 })],
      }),
      phaseName: "coding",
    });
    expect(context).not.toHaveProperty("repos");
    expect(context.branchName).toBe("feature/PROJ-1");
    expect(context.prNumber).toBe(42);
    const rendered = renderSkillPrompt(context, "# skill\n");
    expect(rendered).not.toContain("repos:");
    expect(rendered).not.toContain("mergeCompleted:");
    expect(rendered).not.toContain("terminalPrNumber:");
  });

  it("lists every configured repo and resolves modules against each repo's worktree and base", () => {
    const api = repoCfg("api", {
      modules: [{ name: "core", paths: ["src/**"], buildCommand: "build core" }],
    });
    const web = repoCfg("web", {
      baseBranch: "origin/develop",
      modules: [{ name: "ui", paths: ["ui/**"], buildCommand: "build ui" }],
    });
    const resolveModule = vi
      .fn<ModuleResolver>()
      .mockReturnValueOnce({
        buildCommand: "build core",
        testCommandTargeted: null,
        testCommandFull: null,
      })
      .mockReturnValueOnce({
        buildCommand: "build ui",
        testCommandTargeted: null,
        testCommandFull: null,
      });
    const context = buildSkillContext({
      runtime: makeRuntime({
        project: { directory: "/srv/ws", repos: [api, web, repoCfg("docs")] },
      }),
      task: makeTask(),
      pipelineRecord: makeRecord({
        repos: [
          repoRow("web", { inScope: false, worktreePath: "/srv/ws/worktrees/PROJ-1/web" }),
          repoRow("api", {
            branchName: "feature/PROJ-1",
            prNumber: 42,
            worktreePath: "/srv/ws/worktrees/PROJ-1/api",
          }),
        ],
      }),
      phaseName: "coding",
      resolveModule,
      repoPrBases: { api: "feature/PROJ-0" },
    });
    expect(context.repos).toEqual([
      {
        name: "api",
        path: "/srv/ws/api",
        baseBranch: "origin/main",
        buildCommand: "build api",
        testCommand: "test api",
        inScope: true,
        branchName: "feature/PROJ-1",
        prNumber: 42,
        terminalPrNumber: null,
        mergeCompleted: false,
        module: { buildCommand: "build core", testCommandTargeted: null, testCommandFull: null },
        stackPrBase: "feature/PROJ-0",
      },
      {
        name: "web",
        path: "/srv/ws/web",
        baseBranch: "origin/develop",
        buildCommand: "build web",
        testCommand: "test web",
        inScope: false,
        branchName: null,
        prNumber: null,
        terminalPrNumber: null,
        mergeCompleted: false,
        module: { buildCommand: "build ui", testCommandTargeted: null, testCommandFull: null },
      },
      {
        name: "docs",
        path: "/srv/ws/docs",
        baseBranch: "origin/main",
        buildCommand: "build docs",
        testCommand: "test docs",
        inScope: false,
        branchName: null,
        prNumber: null,
        terminalPrNumber: null,
        mergeCompleted: false,
        module: null,
      },
    ]);
    expect(resolveModule.mock.calls).toEqual([
      ["/srv/ws/worktrees/PROJ-1/api", "origin/main", api.modules],
      ["/srv/ws/worktrees/PROJ-1/web", "origin/develop", web.modules],
    ]);
    expect(context.module).toBe(context.repos?.[0]?.module);
    expect(context.projectDir).toBe("/srv/ws");
  });

  it("uses the first scoped repo in config order for scalars, even when mirrors are stale", () => {
    const web = repoCfg("web", {
      owner: "other-owner",
      repo: "frontend",
      baseBranch: "origin/develop",
      modules: [{ name: "ui", paths: ["ui/**"], buildCommand: "build ui" }],
    });
    const resolveModule = vi.fn(() => ({
      buildCommand: "build ui",
      testCommandTargeted: "test ui",
      testCommandFull: null,
    }));
    const context = buildSkillContext({
      runtime: makeRuntime({
        project: { repos: [repoCfg("api"), web, repoCfg("docs")] },
      }),
      task: makeTask(),
      pipelineRecord: makeRecord({
        branchName: "stale-mirror",
        prNumber: 99,
        worktreePath: "/stale-mirror",
        repos: [
          repoRow("docs", { prNumber: 77 }),
          repoRow("api", { inScope: false }),
          repoRow("web", {
            branchName: "feature/PROJ-1-web",
            prNumber: 43,
            worktreePath: "/srv/ws/worktrees/PROJ-1/web",
          }),
        ],
      }),
      phaseName: "coding",
      resolveModule,
    });
    expect(context).toMatchObject({
      buildCommands: "build web",
      testCommands: "test web",
      repoOwner: "other-owner",
      repoName: "frontend",
      baseBranch: "origin/develop",
      branchName: "feature/PROJ-1-web",
      prNumber: 43,
    });
    expect(resolveModule.mock.calls).toEqual([
      ["/srv/ws/worktrees/PROJ-1/web", "origin/develop", web.modules],
    ]);
    expect(context.module).toBe(context.repos?.[1]?.module);
  });

  it("falls back to repos[0] before scope is set and resolves its module with no worktree", () => {
    const api = repoCfg("api", {
      modules: [{ name: "core", paths: ["src/**"], buildCommand: "build core" }],
    });
    const resolveModule = vi.fn(() => null);
    const context = buildSkillContext({
      runtime: makeRuntime({ project: { repos: [api, repoCfg("web")] } }),
      task: makeTask(),
      pipelineRecord: makeRecord(),
      phaseName: "spec-writing",
      resolveModule,
    });
    expect(context.repos?.map((repo) => repo.inScope)).toEqual([false, false]);
    expect(context.buildCommands).toBe("build api");
    expect(context.repoName).toBe("api");
    expect(context.branchName).toBeNull();
    expect(context.prNumber).toBeNull();
    expect(context.repos?.[0]).not.toHaveProperty("stackPrBase");
    expect(resolveModule.mock.calls).toEqual([[null, "origin/main", api.modules]]);
  });

  it("distinguishes completed merges from unstarted rows and historical terminal PRs", () => {
    const context = buildSkillContext({
      runtime: makeRuntime({
        project: { repos: [repoCfg("api"), repoCfg("web"), repoCfg("docs")] },
      }),
      task: makeTask(),
      pipelineRecord: makeRecord({
        repos: [
          repoRow("api", { mergeCompleted: true, terminalPrNumber: 41 }),
          repoRow("web"),
          repoRow("docs", { terminalPrNumber: 21 }),
        ],
      }),
      phaseName: "code-feedback",
    });
    expect(
      context.repos?.map(({ name, prNumber, terminalPrNumber, mergeCompleted }) => ({
        name,
        prNumber,
        terminalPrNumber,
        mergeCompleted,
      })),
    ).toEqual([
      { name: "api", prNumber: null, terminalPrNumber: 41, mergeCompleted: true },
      { name: "web", prNumber: null, terminalPrNumber: null, mergeCompleted: false },
      { name: "docs", prNumber: null, terminalPrNumber: 21, mergeCompleted: false },
    ]);
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

  it("serializes priorPhase in the YAML context block", () => {
    const runtime = makeRuntime();
    const context = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord({ priorPhase: "code-review" }),
      phaseName: "coding",
    });
    const rendered = renderSkillPrompt(context, "# Skill");
    expect(rendered).toContain("priorPhase: code-review");
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

  describe("workspace mode", () => {
    it("runs the workspace variant instead of the base skill", () => {
      const builtIn = join(tempDir, "builtin");
      writeSkill(builtIn, "coder");
      const variant = writeSkill(builtIn, "coder-workspace");
      expect(resolveSkillPath([builtIn], "coder", [], true)).toBe(variant);
    });

    it("ignores the workspace variant outside workspace mode", () => {
      const builtIn = join(tempDir, "builtin");
      const base = writeSkill(builtIn, "coder");
      writeSkill(builtIn, "coder-workspace");
      expect(resolveSkillPath([builtIn], "coder", [], false)).toBe(base);
      expect(resolveSkillPath([builtIn], "coder", [])).toBe(base);
    });

    it("prefers the bundled variant over a user override of the base skill", () => {
      const userDir = join(tempDir, "user");
      const builtIn = join(tempDir, "builtin");
      writeSkill(userDir, "coder");
      writeSkill(builtIn, "coder");
      const variant = writeSkill(builtIn, "coder-workspace");
      expect(resolveSkillPath([userDir, builtIn], "coder", [], true)).toBe(variant);
    });

    it("lets a user override the workspace variant", () => {
      const userDir = join(tempDir, "user");
      const builtIn = join(tempDir, "builtin");
      const userVariant = writeSkill(userDir, "coder-workspace");
      writeSkill(builtIn, "coder-workspace");
      expect(resolveSkillPath([userDir, builtIn], "coder", [], true)).toBe(userVariant);
    });

    it("falls back to the base skill when no variant exists", () => {
      const userDir = join(tempDir, "user");
      const custom = writeSkill(userDir, "security-audit");
      expect(resolveSkillPath([userDir], "security-audit", [], true)).toBe(custom);
    });

    it("never falls back to the base skill when the variant is disabled", () => {
      const builtIn = join(tempDir, "builtin");
      writeSkill(builtIn, "coder");
      writeSkill(builtIn, "coder-workspace");
      expect(resolveSkillPath([builtIn], "coder", ["coder-workspace"], true)).toBeNull();
    });

    it("returns null when the base skill is disabled, even if the variant exists", () => {
      const builtIn = join(tempDir, "builtin");
      writeSkill(builtIn, "coder-workspace");
      expect(resolveSkillPath([builtIn], "coder", ["coder"], true)).toBeNull();
    });
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
