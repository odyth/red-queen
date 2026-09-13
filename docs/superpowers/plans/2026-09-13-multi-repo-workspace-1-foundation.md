# Multi-Repo Workspaces — Plan 1 of 5: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-09-13-multi-repo-workspace-design.md` (§1–§6 and the `codebaseMapPath` side finding). This is plan 1 of 5; plans 2–5 build on it in order:

1. **Foundation (this plan)** — config `repos[]` + legacy synthesis, source-control registry, `pipeline_repos` table as the source of truth, skill-context `repos` key, `codebaseMapPath` wiring.
2. Per-repo control paths — rework gate, stack blocker gate, webhook routing + merge cleanup per row, reconciler, `spec meta --repos`, `stack setup` per repo, `status`.
3. Skills — all five `SKILL.md` files + skills README.
4. Workspace map, `init` discovery, `init --add-repo`, `redqueen migrate`.
5. Dashboard + docs.

**Goal:** Every consumer reads `config.project.repos`; branch/PR/worktree state lives in `pipeline_repos` rows; a registry hands out one `SourceControl` adapter per repo — with **zero behavior change for existing single-repo installs** (legacy mode) and byte-identical legacy skill context blocks.

**Architecture:** `parseConfig` stays pure and returns a resolved `RedQueenConfig` whose `project.repos` is always populated (declared in workspace mode, synthesized from today's fields in legacy mode) plus an internal `project.workspaceMode` flag. `loadConfig` adds filesystem validation. `buildAdapterPair` builds one adapter per repo sharing one auth strategy and returns a `SourceControlRegistry`. `PipelineStateStore` gains a `pipeline_repos` table; every branch/PR/worktree write goes through per-row methods that refresh the `pipeline_state` scalar mirror in the same transaction; `PipelineRecord.repos` exposes the rows and the scalar fields are derived from the first in-scope row. After this plan, workspace-mode configs parse and run, but every control path still acts on the **first in-scope row** (plan 2 makes them loop rows) and the skills do not yet read `repos` (plan 3).

**Tech Stack:** TypeScript 5 (`strict`), zod v4, better-sqlite3, vitest, `yaml`. Node ≥ 24.

## Global Constraints

Copied from the spec and project rules; every task inherits them.

- Repo names match `^[a-z0-9][a-z0-9-]*$`. Hand-written `repos[].name` values must already match; they are never transformed.
- `deriveRepoName(repo)`: lowercase, collapse each run of characters outside `[a-z0-9]` to `-`, strip leading and trailing `-`; empty result is a `ConfigError` naming the source repo.
- Legacy mode (`project.repos` absent): synthesize `repos = [{ name: deriveRepoName(<sourceControl repo name>) or "default" for mock, path: project.directory, owner, repo, baseBranch: pipeline.baseBranch, buildCommand, testCommand, modules }]` and `workspaceMode: false`.
- Workspace mode rejects `project.buildCommand`, `project.testCommand`, `project.modules`, `sourceControl.config.owner`, `sourceControl.config.repo` with a message pointing at `repos[]`. Names unique. At least one repo. `repos[].baseBranch` defaults to `pipeline.baseBranch`.
- `sourceControl.config.auth.type === "byo-app"` ⇒ every `repos[].owner` identical, else `ConfigError` listing the owners. Token auth allows any mix.
- `repos[].path` must exist and be a git work tree root at `loadConfig` time (not in the zod schema).
- Only skill-context rendering, worktree layout, the adapter pairing check, and the dashboard header label branch on `workspaceMode`. Everything else reads `config.project.repos`.
- `pipeline_state` scalar PR columns stay as a **read-only mirror** of the first in-scope repo row, refreshed in the same transaction as every per-row write. Readers of the mirror are display-only; every control decision reads rows.
- Legacy-row adoption: for each `pipeline_state` row with non-null `branch_name`, `pr_number`, `worktree_path`, or `spec_content` and no `pipeline_repos` rows, insert one row `{ repo: repos[0].name, in_scope: 1 }` copying the scalars. Idempotent. Runs on every orchestrator start before polling (and in `loadCliContext`).
- Skill context: workspace mode adds `repos` (omitted entirely in legacy mode via conditional spread); legacy scalar fields stay and are populated from the first in-scope repo (or `repos[0]` before scope is set).
- Code style (CLAUDE.md / AGENTS.md): no `!` operator except `!=`/`!==`; `if (x === false)` not `if (!x)`; always `{}` braces; 2 spaces; double quotes; trailing commas; 100-col; no `Co-Authored-By` lines in commits; commit messages say _why_.
- After every code change run `npm run check` (tsc + tsc client + eslint + prettier) — all three must pass. Run `npx vitest run <file>` for targeted tests.

---

## File Structure

| File                                                       | Responsibility after this plan                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/core/config.ts`                                       | Zod schema incl. `RepoSchema`; `deriveRepoName`; `legacyRepoConfig`; `resolveRepos`; `resolveProjectPaths`    |
| `src/core/__tests__/fixtures/test-config.ts`               | `makeTestConfig` synthesizes `repos` when the override omits them                                             |
| `src/integrations/source-control-registry.ts`              | `SourceControlRegistry` interface + `createSourceControlRegistry`                                             |
| `src/integrations/github/adapter.ts`                       | Config schema split into auth-only + owner/repo                                                               |
| `src/cli/adapters.ts`                                      | `buildAdapterPair` → `{ issueTracker, sourceControls, warmup }`                                               |
| `src/core/database.ts`                                     | `pipeline_repos` table + index in `SCHEMA_SQL`                                                                |
| `src/core/types.ts`                                        | `PipelineRepoRecord`, `PipelineRecord.repos`, `SkillContextRepo`, `SkillContext.repos?`                       |
| `src/core/pipeline-state.ts`                               | Per-row store API, mirror refresh, `setScope`, `markPrMerged` per row, `findByPr`, `adoptLegacyRows`, helpers |
| `src/core/orchestrator.ts`                                 | `deps.sourceControls`; adoption at start; `dismissStaleReviews` per in-scope PR; label; `codebaseMapPath`     |
| `src/webhook/server.ts`                                    | `deps.sourceControls`; adapter chosen from the acting record's primary row (plan 2 loops rows)                |
| `src/cli/repo-arg.ts`                                      | `resolveRepoArg` — `--repo` resolution shared by helpers                                                      |
| `src/cli/pr.ts`, `src/cli/pipeline.ts`, `src/cli/stack.ts` | `--repo` on `pr *` and `pipeline update`; per-row writes                                                      |
| `src/cli/context.ts`, `src/cli/start.ts`                   | Registry wiring, store constructed with config repo names, adoption pass                                      |
| `src/core/skill-context.ts`                                | `repos` key, scalar fallbacks, per-repo module resolution                                                     |
| `src/skills/README.md`                                     | Contract table gains `repos` and marks scalar fields deprecated in workspace mode                             |

---

### Task 1: `deriveRepoName`

**Files:**

- Modify: `src/core/config.ts` (add after the `ConfigError` class, ~line 275)
- Test: `src/core/__tests__/config.test.ts`

**Interfaces:**

- Produces: `export const REPO_NAME_RE: RegExp`, `export function deriveRepoName(repo: string): string` (throws `ConfigError`).

- [ ] **Step 1: Write the failing test**

Append to `src/core/__tests__/config.test.ts` (add `deriveRepoName`, `REPO_NAME_RE` to the existing `import { ... } from "../config.js"`):

```ts
describe("deriveRepoName", () => {
  it("lowercases and collapses non-alphanumeric runs to single hyphens", () => {
    expect(deriveRepoName("AlignSmart")).toBe("alignsmart");
    expect(deriveRepoName("Email_Templates.v2")).toBe("email-templates-v2");
    expect(deriveRepoName("image__resizer")).toBe("image-resizer");
  });

  it("strips leading and trailing hyphens", () => {
    expect(deriveRepoName("--App--")).toBe("app");
    expect(deriveRepoName(".github")).toBe("github");
  });

  it("throws a ConfigError naming the source repo when nothing survives", () => {
    expect(() => deriveRepoName("___")).toThrow(ConfigError);
    expect(() => deriveRepoName("___")).toThrow(/"___"/);
  });

  it("always satisfies REPO_NAME_RE", () => {
    for (const input of ["A", "9lives", "Foo Bar", "x-y_z", "MiXeD.Case-Repo"]) {
      expect(REPO_NAME_RE.test(deriveRepoName(input))).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/__tests__/config.test.ts -t deriveRepoName`
Expected: FAIL — `deriveRepoName is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

In `src/core/config.ts`, directly after the `ConfigError` class:

```ts
export const REPO_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/__tests__/config.test.ts -t deriveRepoName`
Expected: PASS (4 tests).

- [ ] **Step 5: Check + commit**

```bash
npm run check
git add src/core/config.ts src/core/__tests__/config.test.ts
git commit -m "feat(config): add deriveRepoName as the single rule for derived repo names"
```

---

### Task 2: `project.repos[]` schema, legacy synthesis, validation

**Files:**

- Modify: `src/core/config.ts` (schema lines 110–135, `superRefine` 232–262, types 264–266, `loadConfig`/`parseConfig` 302–317)
- Modify: `src/core/__tests__/fixtures/test-config.ts`
- Modify: `src/__tests__/e2e/full-loop.test.ts` (`buildConfig`, lines 41–70)
- Modify: `src/index.ts` (export `RepoConfig`, `deriveRepoName`, `legacyRepoConfig`, `resolveProjectPaths`)
- Test: `src/core/__tests__/config.test.ts`

**Interfaces:**

- Produces:
  ```ts
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
  export type RedQueenConfig = Omit<RawConfig, "project"> & {
    project: Omit<RawConfig["project"], "repos"> & { repos: RepoConfig[]; workspaceMode: boolean };
  };
  export function legacyRepoConfig(input: LegacyRepoInput): RepoConfig;
  export function parseConfig(yamlContent: string): RedQueenConfig; // pure, resolves repos
  export function loadConfig(filePath: string): RedQueenConfig; // + path validation, absolute repo paths
  export function resolveProjectPaths(config: RedQueenConfig, projectRoot: string): RedQueenConfig;
  ```
- Consumes: `deriveRepoName` (Task 1).

- [ ] **Step 1: Write the failing tests**

Append to `src/core/__tests__/config.test.ts` (extend the import with `legacyRepoConfig`, `resolveProjectPaths`; also `import { mkdirSync } from "node:fs"` alongside the existing fs imports):

```ts
describe("project.repos (workspace mode)", () => {
  const workspaceYaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
  config:
    auth: { type: pat, token: tok }
project:
  repos:
    - name: alignsmart
      path: ./AlignSmart
      owner: alignsmart
      repo: AlignSmart
      baseBranch: origin/master
      buildCommand: dotnet build
      testCommand: dotnet test
      modules:
        - name: portal
          paths: ["src/Portal/**"]
          buildCommand: dotnet build src/Portal
          testCommandTargeted: dotnet test src/Portal.Tests
    - name: app
      path: ./App
      owner: alignsmart
      repo: App
      buildCommand: npm run build
      testCommand: npm test
`;

  it("parses repos with nested modules and defaults baseBranch to pipeline.baseBranch", () => {
    const config = parseConfig(workspaceYaml);
    expect(config.project.workspaceMode).toBe(true);
    expect(config.project.repos.map((r) => r.name)).toEqual(["alignsmart", "app"]);
    expect(config.project.repos[0]?.baseBranch).toBe("origin/master");
    expect(config.project.repos[1]?.baseBranch).toBe("origin/main");
    expect(config.project.repos[0]?.modules).toEqual([
      {
        name: "portal",
        paths: ["src/Portal/**"],
        buildCommand: "dotnet build src/Portal",
        testCommandTargeted: "dotnet test src/Portal.Tests",
      },
    ]);
    expect(config.project.repos[1]?.modules).toEqual([]);
    expect(config.project.buildCommand).toBeUndefined();
  });

  it("rejects duplicate repo names", () => {
    const yaml = workspaceYaml.replace("name: app", "name: alignsmart");
    expect(() => parseConfig(yaml)).toThrow(/Duplicate repo name "alignsmart"/);
  });

  it("rejects an empty repos list", () => {
    const yaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  repos: []
`;
    expect(() => parseConfig(yaml)).toThrow(/at least one repo/);
  });

  it("rejects hand-written names outside the repo name regex", () => {
    const yaml = workspaceYaml.replace("name: app", "name: App");
    expect(() => parseConfig(yaml)).toThrow(/repos\[\]\.name/);
  });

  it.each([
    ["project.buildCommand", "project:\n  buildCommand: x\n  repos:"],
    ["project.testCommand", "project:\n  testCommand: x\n  repos:"],
    [
      "project.modules",
      'project:\n  modules: [{ name: m, paths: ["a"], buildCommand: b }]\n  repos:',
    ],
  ])("rejects %s in workspace mode", (key, replacement) => {
    const yaml = workspaceYaml.replace("project:\n  repos:", replacement);
    expect(() => parseConfig(yaml)).toThrow(
      new RegExp(`${key.replace(".", "\\.")} is not allowed in workspace mode`),
    );
  });

  it("rejects sourceControl.config.owner/repo in workspace mode", () => {
    const yaml = workspaceYaml.replace(
      "auth: { type: pat, token: tok }",
      "auth: { type: pat, token: tok }\n    owner: alignsmart\n    repo: AlignSmart",
    );
    expect(() => parseConfig(yaml)).toThrow(
      /sourceControl\.config\.owner is not allowed in workspace mode/,
    );
  });

  it("rejects more than one owner under GitHub App auth and lists them", () => {
    const yaml = workspaceYaml
      .replace(
        "auth: { type: pat, token: tok }",
        "auth: { type: byo-app, appId: 1, installationId: 2, privateKeyPath: k.pem }",
      )
      .replace("owner: alignsmart\n      repo: App", "owner: other-org\n      repo: App");
    expect(() => parseConfig(yaml)).toThrow(/scoped to one owner.*alignsmart.*other-org/);
  });

  it("accepts mixed owners under token auth", () => {
    const yaml = workspaceYaml.replace(
      "owner: alignsmart\n      repo: App",
      "owner: other-org\n      repo: App",
    );
    expect(parseConfig(yaml).project.repos[1]?.owner).toBe("other-org");
  });

  it("accepts a github-issues tracker whose repo is outside repos[]", () => {
    const yaml = workspaceYaml.replace(
      "type: jira",
      "type: github-issues\n  config:\n    owner: alignsmart\n    repo: Planning\n    auth: { type: pat, token: tok }",
    );
    expect(parseConfig(yaml).issueTracker.config.repo).toBe("Planning");
  });
});

describe("legacy synthesis", () => {
  it("synthesizes repos[0] from top-level fields for a github source control", () => {
    const config = parseConfig(`
issueTracker:
  type: jira
sourceControl:
  type: github
  config:
    owner: acme
    repo: My_App
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
  directory: ./src
  modules:
    - name: web
      paths: ["web/**"]
      buildCommand: b
pipeline:
  baseBranch: origin/develop
`);
    expect(config.project.workspaceMode).toBe(false);
    expect(config.project.repos).toEqual([
      {
        name: "my-app",
        path: "./src",
        owner: "acme",
        repo: "My_App",
        baseBranch: "origin/develop",
        buildCommand: "npm run build",
        testCommand: "npm test",
        modules: [{ name: "web", paths: ["web/**"], buildCommand: "b", testCommandTargeted: null }],
      },
    ]);
    expect(config.project.buildCommand).toBe("npm run build");
  });

  it('names the synthesized repo "default" for the mock source control', () => {
    const config = parseConfig(`
issueTracker:
  type: mock
sourceControl:
  type: mock
project:
  buildCommand: echo
  testCommand: echo
`);
    expect(config.project.repos[0]?.name).toBe("default");
    expect(config.project.repos[0]?.owner).toBe("");
  });

  it("still requires buildCommand and testCommand in legacy mode", () => {
    expect(() =>
      parseConfig(`
issueTracker:
  type: mock
sourceControl:
  type: mock
project:
  directory: .
`),
    ).toThrow(/project\.buildCommand is required/);
  });
});

describe("loadConfig path validation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rq-config-ws-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const yaml = `
issueTracker:
  type: mock
sourceControl:
  type: mock
project:
  repos:
    - name: a
      path: ./A
      owner: o
      repo: A
      buildCommand: b
      testCommand: t
`;

  it("absolutizes repo paths and accepts git work tree roots", () => {
    mkdirSync(join(dir, "A", ".git"), { recursive: true });
    writeFileSync(join(dir, "redqueen.yaml"), yaml);
    const config = loadConfig(join(dir, "redqueen.yaml"));
    expect(config.project.repos[0]?.path).toBe(join(dir, "A"));
  });

  it("throws a ConfigError naming the entry when the path is not a git work tree root", () => {
    mkdirSync(join(dir, "A"), { recursive: true });
    writeFileSync(join(dir, "redqueen.yaml"), yaml);
    expect(() => loadConfig(join(dir, "redqueen.yaml"))).toThrow(ConfigError);
    expect(() => loadConfig(join(dir, "redqueen.yaml"))).toThrow(/repos\[a\]\.path/);
  });

  it("does not validate the synthesized legacy repo path", () => {
    writeFileSync(
      join(dir, "redqueen.yaml"),
      "issueTracker:\n  type: mock\nsourceControl:\n  type: mock\nproject:\n  buildCommand: b\n  testCommand: t\n  directory: ./nope\n",
    );
    expect(loadConfig(join(dir, "redqueen.yaml")).project.repos[0]?.path).toBe("./nope");
  });
});

describe("resolveProjectPaths", () => {
  it("absolutizes project.directory and every repo path against the project root", () => {
    const config = parseConfig(`
issueTracker:
  type: mock
sourceControl:
  type: mock
project:
  buildCommand: b
  testCommand: t
  directory: ./sub
`);
    const resolved = resolveProjectPaths(config, "/srv/root");
    expect(resolved.project.directory).toBe("/srv/root/sub");
    expect(resolved.project.repos[0]?.path).toBe("/srv/root/sub");
  });
});
```

Also add the new import `import { beforeEach, afterEach } from "vitest"` if `beforeEach`/`afterEach` are not already imported in this file (they are not — extend the first line: `import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/__tests__/config.test.ts`
Expected: FAIL — `project.repos` unknown, `legacyRepoConfig`/`resolveProjectPaths` not exported.

- [ ] **Step 3: Implement the schema, types, and resolution**

In `src/core/config.ts`:

(a) Add imports at top:

```ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
```

(b) Replace the `project:` block inside `ConfigSchema` (lines 120–135) with:

```ts
    project: z.object({
      buildCommand: z.string().optional(),
      testCommand: z.string().optional(),
      directory: z.string().default("."),
      modules: z.array(ProjectModuleSchema).optional(),
      repos: z.array(RepoSchema).min(1, "project.repos must list at least one repo").optional(),
    }),
```

and define these two schemas **above** `ConfigSchema` (after `CostSchema`):

```ts
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
```

`REPO_NAME_RE` is declared later in the file (Task 1); move its `export const REPO_NAME_RE = ...` line up next to `SKILL_NAME_RE` (line 11) so it is defined before `RepoSchema`.

(c) Replace the `.superRefine((config, ctx) => { ... })` body (lines 232–262) with:

```ts
  .superRefine((config, ctx) => {
    refineRepos(config, ctx);
    refineWebhooks(config, ctx);
  });
```

and add these functions **below** `ConfigSchema` (they reference the raw input type, so declare the type first):

```ts
type RawConfigInput = z.input<typeof ConfigSchema>;
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
  repos.forEach((repo, index) => {
    if (seen.has(repo.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["project", "repos", index, "name"],
        message: `Duplicate repo name "${repo.name}"`,
      });
    }
    seen.add(repo.name);
  });
  const auth = config.sourceControl.config.auth;
  const authType =
    typeof auth === "object" && auth !== null ? (auth as { type?: unknown }).type : undefined;
  if (authType === "byo-app") {
    const owners = [...new Set(repos.map((r) => r.owner))];
    if (owners.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["project", "repos"],
        message: `GitHub App auth is scoped to one owner, but repos[] spans owners ${owners.join(", ")} — use token auth or split the workspace`,
      });
    }
  }
}
```

(d) Replace the two type exports (lines 264–266) with:

```ts
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
```

(e) Replace `loadConfig` and `parseConfig` (lines 302–317) with:

```ts
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
// paths follow it so `repo.path` is always usable as a git cwd downstream.
export function resolveProjectPaths(config: RedQueenConfig, projectRoot: string): RedQueenConfig {
  const directory = resolve(projectRoot, config.project.directory);
  const repos = config.project.repos.map((repo) => ({
    ...repo,
    path: resolve(directory, repo.path),
  }));
  return { ...config, project: { ...config.project, directory, repos } };
}
```

`checkDisabledSkills(config: RedQueenConfig)` — change its parameter type to `RawConfig` (it only reads `skills` and `phases`).

(f) In `src/index.ts`, extend the config exports:

```ts
export type { RedQueenConfig, ProjectModule, RepoConfig, LegacyRepoInput } from "./core/config.js";
export {
  loadConfig,
  parseConfig,
  validatePhaseGraph,
  buildPhaseGraph,
  deriveRepoName,
  legacyRepoConfig,
  resolveProjectPaths,
  ConfigSchema,
  PhaseDefinitionSchema,
} from "./core/config.js";
```

- [ ] **Step 4: Update the test fixture and the e2e config literal**

Replace `src/core/__tests__/fixtures/test-config.ts` entirely:

```ts
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
      webhooks: { enabled: false },
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
    dashboard: { enabled: true, port: 4400, host: "127.0.0.1" },
    audit: { logFile: "audit.log", retentionDays: 30 },
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
      buildCommand: project.buildCommand ?? "",
      testCommand: project.testCommand ?? "",
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
```

Note: `pipeline.webhooks: { enabled: false }` and `dashboard: {...}` are accepted as today because the zod-inferred pipeline/dashboard types carry defaults; do not change them.

In `src/__tests__/e2e/full-loop.test.ts`, change the `buildConfig` `project` block:

```ts
    project: {
      buildCommand: "npm run build",
      testCommand: "npm test",
      directory: tempDir,
      repos: [
        legacyRepoConfig({
          directory: tempDir,
          buildCommand: "npm run build",
          testCommand: "npm test",
          modules: [],
          sourceControlType: "mock",
          sourceControlConfig: { owner: "acme", repo: "e2e" },
          baseBranch: "origin/main",
        }),
      ],
      workspaceMode: false,
    },
```

and add `legacyRepoConfig` to the `../../core/config.js` import.

Run `npm run check`; tsc will flag any other literal `RedQueenConfig` object (search `phases: DEFAULT_PHASES,` in `src/**/__tests__` to find them). Fix each the same way: add `repos: [legacyRepoConfig({...})]` and `workspaceMode: false` to its `project` block, or switch the literal to `makeTestConfig(...)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/core/__tests__/config.test.ts src/core/__tests__/skill-context.test.ts src/__tests__/e2e`
Expected: PASS. The existing "parses minimal config with defaults applied" test still passes (legacy fields remain on the resolved config).

- [ ] **Step 6: Check + commit**

```bash
npm run check
git add src/core/config.ts src/core/__tests__/config.test.ts src/core/__tests__/fixtures/test-config.ts src/__tests__/e2e/full-loop.test.ts src/index.ts
git commit -m "feat(config): project.repos[] workspace mode with legacy single-repo synthesis"
```

---

### Task 3: `pipeline_repos` table and per-row store API

**Files:**

- Modify: `src/core/database.ts` (`SCHEMA_SQL`, after `pipeline_state`)
- Modify: `src/core/types.ts` (`PipelineRecord`, new `PipelineRepoRecord`)
- Modify: `src/core/pipeline-state.ts`
- Modify: `src/core/__tests__/stack.test.ts` (`record()` helper, line 9) and `src/core/__tests__/skill-context.test.ts` (`makeRecord()`, line 35): add `repos: []`
- Modify callers of the changed signatures (this task keeps them compiling with the record's primary row): `src/webhook/server.ts:373,656,714,735`, `src/cli/stack.ts:173`, `src/cli/pipeline.ts:79,151`, `src/cli/pr.ts:109`
- Test: `src/core/__tests__/pipeline-state.test.ts`, `src/core/__tests__/database.test.ts`

**Interfaces:**

- Produces (all on `PipelineStateStore` unless noted):
  ```ts
  export const DEFAULT_REPO_NAME = "default";
  constructor(db: BetterSqlite3.Database, repoNames: readonly string[] = [DEFAULT_REPO_NAME]);
  get defaultRepo(): string;                                   // repoNames[0]
  listRepos(issueId: string): PipelineRepoRecord[];           // config order
  getRepo(issueId: string, repo: string): PipelineRepoRecord | null;
  setScope(issueId: string, repoNames: readonly string[]): PipelineRepoRecord[];
  updateBranchInfo(issueId: string, repo: string, info: BranchInfoUpdate): PipelineRepoRecord; // upsert row
  updateBranch(issueId: string, repo: string, branchName: string): boolean;
  updatePrNumber(issueId: string, repo: string, prNumber: number, prBaseBranch: string | null): boolean;
  updateWorktreePath(issueId: string, repo: string, worktreePath: string | null): boolean;
  markPrMerged(issueId: string, repo: string, mergedPrNumber: number | null): MergeTransitionResult;
  findByPr(repo: string, prNumber: number): PipelineRecord | null;
  adoptLegacyRows(repoName: string): string[];                 // adopted issue ids
  export type MergeTransitionResult = "processed" | "already-processed" | "stale" | "missing" | "pending-others";
  export function classifyRepoMergeTransition(currentPhase: string | null, row: PipelineRepoRecord, mergedPrNumber: number | null): "process" | "already-processed" | "stale";
  export function firstInScopeRepo(repos: readonly PipelineRepoRecord[]): PipelineRepoRecord | null;
  export function primaryRepoName(record: Pick<PipelineRecord, "repos">, fallback: string): string;
  ```
  and in `types.ts`:
  ```ts
  export interface PipelineRepoRecord {
    issueId: string;
    repo: string;
    inScope: boolean;
    branchName: string | null;
    prNumber: number | null;
    prBaseBranch: string | null;
    terminalPrNumber: number | null;
    worktreePath: string | null;
    createdAt: string;
    updatedAt: string;
  }
  // PipelineRecord gains: repos: PipelineRepoRecord[]  (scalar fields derived from the first in-scope row)
  ```
- Semantics: `markPrMerged` returns `"processed"` only when the merged row was in scope and it was the **last** in-scope row with a PR — the issue is then marked `done` inside the same transaction. Any other successful row transition (other in-scope PRs still open, or the row is descoped) returns `"pending-others"` and never touches the issue phase.

- [ ] **Step 1: Write the failing tests**

In `src/core/__tests__/pipeline-state.test.ts`, change the store construction in `beforeEach` to `store = new PipelineStateStore(db, ["app", "web"]);` and update the existing scalar-signature calls:

- `store.updateBranch("PROJ-1", "feature/x")` → `store.updateBranch("PROJ-1", "app", "feature/x")`
- `store.updatePrNumber("PROJ-1", 42)` → `store.updatePrNumber("PROJ-1", "app", 42, null)`
- `store.updateWorktreePath("PROJ-1", "/w")` → `store.updateWorktreePath("PROJ-1", "app", "/w")`
- `store.updateBranchInfo("PROJ-1", { ... })` → `store.updateBranchInfo("PROJ-1", "app", { ... })`
- `store.markPrMerged("PROJ-1", 42)` → `store.markPrMerged("PROJ-1", "app", 42)`

Keep every existing assertion on `store.get(...)?.branchName` etc. — the scalars are now derived from the `app` row and must produce the same values.

Then append:

```ts
describe("PipelineStateStore pipeline_repos", () => {
  beforeEach(() => {
    db = createTestDb();
    store = new PipelineStateStore(db, ["app", "web"]);
  });
  afterEach(() => {
    db.close();
  });

  it("starts with no repo rows and null scalars", () => {
    const record = store.create("PROJ-1", "spec-writing");
    expect(record.repos).toEqual([]);
    expect(record.branchName).toBeNull();
    expect(record.prNumber).toBeNull();
  });

  it("setScope upserts in-scope rows in config order and descopes the rest", () => {
    store.create("PROJ-1");
    const rows = store.setScope("PROJ-1", ["web", "app"]);
    expect(rows.map((r) => [r.repo, r.inScope])).toEqual([
      ["app", true],
      ["web", true],
    ]);
    const after = store.setScope("PROJ-1", ["web"]);
    expect(after.map((r) => [r.repo, r.inScope])).toEqual([
      ["app", false],
      ["web", true],
    ]);
  });

  it("descoping a row with an open PR keeps its branch, PR, and worktree", () => {
    store.create("PROJ-1");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updateBranchInfo("PROJ-1", "app", {
      branchName: "feature/PROJ-1",
      prNumber: 7,
      prBaseBranch: "main",
      worktreePath: "/w/app",
    });
    store.setScope("PROJ-1", ["web"]);
    const app = store.getRepo("PROJ-1", "app");
    expect(app?.inScope).toBe(false);
    expect(app?.prNumber).toBe(7);
    expect(app?.branchName).toBe("feature/PROJ-1");
    expect(app?.worktreePath).toBe("/w/app");
  });

  it("mirrors the first in-scope row into the pipeline_state scalars", () => {
    store.create("PROJ-1");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updatePrNumber("PROJ-1", "web", 5, "main");
    store.updatePrNumber("PROJ-1", "app", 9, "main");
    expect(store.get("PROJ-1")?.prNumber).toBe(9);
    const raw = db
      .prepare("SELECT pr_number, pr_base_branch FROM pipeline_state WHERE issue_id = ?")
      .get("PROJ-1") as { pr_number: number | null; pr_base_branch: string | null };
    expect(raw).toEqual({ pr_number: 9, pr_base_branch: "main" });
    store.setScope("PROJ-1", ["web"]);
    expect(store.get("PROJ-1")?.prNumber).toBe(5);
  });

  it("updateBranchInfo on an unknown row upserts it in scope", () => {
    store.create("PROJ-1");
    const row = store.updateBranchInfo("PROJ-1", "web", { branchName: "b" });
    expect(row.inScope).toBe(true);
    expect(row.branchName).toBe("b");
  });

  it("updateBranchInfo throws when the pipeline record is missing", () => {
    expect(() => store.updateBranchInfo("nope", "app", { branchName: "b" })).toThrow(
      /no pipeline record/,
    );
  });

  it("markPrMerged marks done only when the last in-scope PR merges", () => {
    store.create("PROJ-1", "human-review");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updatePrNumber("PROJ-1", "app", 1, "main");
    store.updatePrNumber("PROJ-1", "web", 2, "main");

    expect(store.markPrMerged("PROJ-1", "app", 1)).toBe("pending-others");
    expect(store.get("PROJ-1")?.currentPhase).toBe("human-review");
    expect(store.getRepo("PROJ-1", "app")).toMatchObject({
      prNumber: null,
      terminalPrNumber: 1,
      prBaseBranch: null,
    });

    expect(store.markPrMerged("PROJ-1", "web", 2)).toBe("processed");
    const done = store.get("PROJ-1");
    expect(done?.currentPhase).toBe("done");
    expect(done?.priorPhase).toBe("human-review");
    expect(done?.terminalPrNumber).toBe(1);
  });

  it("markPrMerged on a descoped row transitions the row but never advances the issue", () => {
    store.create("PROJ-1", "human-review");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updatePrNumber("PROJ-1", "app", 1, "main");
    store.setScope("PROJ-1", ["web"]);
    expect(store.markPrMerged("PROJ-1", "app", 1)).toBe("pending-others");
    expect(store.get("PROJ-1")?.currentPhase).toBe("human-review");
    expect(store.getRepo("PROJ-1", "app")?.terminalPrNumber).toBe(1);
  });

  it("markPrMerged reports duplicates and stale PRs per row", () => {
    store.create("PROJ-1", "human-review");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updatePrNumber("PROJ-1", "app", 1, "main");
    store.updatePrNumber("PROJ-1", "web", 2, "main");
    store.markPrMerged("PROJ-1", "app", 1);
    expect(store.markPrMerged("PROJ-1", "app", 1)).toBe("already-processed");
    expect(store.markPrMerged("PROJ-1", "web", 99)).toBe("stale");
    expect(store.markPrMerged("PROJ-1", "nope", 1)).toBe("missing");
    expect(store.markPrMerged("nope", "app", 1)).toBe("missing");
  });

  it("findByPr resolves the issue by repo and PR number", () => {
    store.create("PROJ-1");
    store.create("PROJ-2");
    store.updatePrNumber("PROJ-1", "app", 10, "main");
    store.updatePrNumber("PROJ-2", "web", 10, "main");
    expect(store.findByPr("web", 10)?.issueId).toBe("PROJ-2");
    expect(store.findByPr("app", 11)).toBeNull();
  });

  it("markDone records terminal PR numbers per in-scope row and keeps pr_number", () => {
    store.create("PROJ-1", "human-review");
    store.updatePrNumber("PROJ-1", "app", 3, "main");
    store.markDone("PROJ-1");
    expect(store.getRepo("PROJ-1", "app")).toMatchObject({ prNumber: 3, terminalPrNumber: 3 });
    expect(store.get("PROJ-1")?.terminalPrNumber).toBe(3);
  });

  it("delete removes repo rows too", () => {
    store.create("PROJ-1");
    store.updateBranch("PROJ-1", "app", "b");
    store.delete("PROJ-1");
    expect(db.prepare("SELECT COUNT(*) AS c FROM pipeline_repos").get()).toEqual({ c: 0 });
  });

  it("listAll attaches repo rows to every record", () => {
    store.create("PROJ-1");
    store.create("PROJ-2");
    store.updateBranch("PROJ-2", "web", "b");
    const all = store.listAll();
    expect(all.find((r) => r.issueId === "PROJ-2")?.repos.map((r) => r.repo)).toEqual(["web"]);
    expect(all.find((r) => r.issueId === "PROJ-1")?.repos).toEqual([]);
  });
});

describe("PipelineStateStore.adoptLegacyRows", () => {
  beforeEach(() => {
    db = createTestDb();
    store = new PipelineStateStore(db, ["app"]);
  });
  afterEach(() => {
    db.close();
  });

  function insertLegacy(
    issueId: string,
    cols: Partial<
      Record<
        | "branch_name"
        | "pr_number"
        | "worktree_path"
        | "spec_content"
        | "terminal_pr_number"
        | "current_phase",
        string | number | null
      >
    >,
  ): void {
    const keys = Object.keys(cols);
    db.prepare(
      `INSERT INTO pipeline_state (issue_id, created_at, updated_at${keys.map((k) => `, ${k}`).join("")})
       VALUES (?, ?, ?${keys.map(() => ", ?").join("")})`,
    ).run(issueId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", ...Object.values(cols));
  }

  it("adopts rows with branch, PR, worktree, spec, or terminal PR into repos[0] and is idempotent", () => {
    insertLegacy("A", { branch_name: "feature/A", pr_number: 4, worktree_path: "/w/A" });
    insertLegacy("B", { spec_content: "spec" });
    insertLegacy("C", { current_phase: "done", terminal_pr_number: 8 });
    insertLegacy("D", {});
    expect(store.adoptLegacyRows("app").sort()).toEqual(["A", "B", "C"]);
    expect(store.adoptLegacyRows("app")).toEqual([]);
    expect(store.getRepo("A", "app")).toMatchObject({
      inScope: true,
      branchName: "feature/A",
      prNumber: 4,
      worktreePath: "/w/A",
    });
    expect(store.getRepo("B", "app")?.inScope).toBe(true);
    expect(store.getRepo("C", "app")?.terminalPrNumber).toBe(8);
    expect(store.listRepos("D")).toEqual([]);
    expect(store.get("A")?.prNumber).toBe(4);
  });

  it("skips issues that already have repo rows", () => {
    insertLegacy("A", { branch_name: "old" });
    store.updateBranch("A", "app", "new");
    expect(store.adoptLegacyRows("app")).toEqual([]);
    expect(store.getRepo("A", "app")?.branchName).toBe("new");
  });
});
```

In `src/core/__tests__/database.test.ts` add:

```ts
it("creates the pipeline_repos table and index on a fresh database", () => {
  tempDir = mkdtempSync(join(tmpdir(), "rq-database-"));
  const db = new RedQueenDatabase(join(tempDir, "redqueen.db"));
  const tables = db.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE 'pipeline_repos%' OR name = 'idx_pipeline_repos_pr'",
    )
    .all() as { name: string }[];
  expect(tables.map((t) => t.name).sort()).toEqual(["idx_pipeline_repos_pr", "pipeline_repos"]);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/__tests__/pipeline-state.test.ts src/core/__tests__/database.test.ts`
Expected: FAIL — table missing, methods missing / wrong arity.

- [ ] **Step 3: Add the table**

In `src/core/database.ts`, insert after the `pipeline_state` CREATE TABLE (after line 43):

```sql
  CREATE TABLE IF NOT EXISTS pipeline_repos (
    issue_id           TEXT NOT NULL,
    repo               TEXT NOT NULL,
    in_scope           INTEGER NOT NULL DEFAULT 1,
    branch_name        TEXT,
    pr_number          INTEGER,
    pr_base_branch     TEXT,
    terminal_pr_number INTEGER,
    worktree_path      TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    PRIMARY KEY (issue_id, repo)
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_repos_pr ON pipeline_repos(repo, pr_number);
```

No `runMigrations` change: `CREATE TABLE IF NOT EXISTS` in `SCHEMA_SQL` covers existing databases. Adoption is data, not schema, and lives in the store.

- [ ] **Step 4: Add the types**

In `src/core/types.ts`, above `PipelineRecord`:

```ts
// One row per (issue, repo). Rows are the source of truth for branch / PR /
// worktree state; pipeline_state's scalar columns mirror the first in-scope
// row for display-only readers.
export interface PipelineRepoRecord {
  issueId: string;
  repo: string;
  inScope: boolean;
  branchName: string | null;
  prNumber: number | null;
  prBaseBranch: string | null;
  terminalPrNumber: number | null;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}
```

and add to `PipelineRecord` (after `openQuestionCount`):

```ts
  // Ordered as in config. branchName / prNumber / prBaseBranch /
  // terminalPrNumber / worktreePath above are derived from the first in-scope
  // row (null when none) — control decisions must read `repos` directly.
  repos: PipelineRepoRecord[];
```

Export it from `src/index.ts` next to `PipelineRecord`.

- [ ] **Step 5: Rewrite the store**

Replace `src/core/pipeline-state.ts` from the top through the end of `class PipelineStateStore` (keep `OrchestratorStateStore` unchanged) with:

```ts
import type BetterSqlite3 from "better-sqlite3";
import type {
  OrchestratorState,
  OrchestratorStatus,
  PipelineRecord,
  PipelineRepoRecord,
} from "./types.js";

export const DEFAULT_REPO_NAME = "default";

// --- Row shapes ---

interface PipelineRow {
  issue_id: string;
  current_phase: string | null;
  prior_phase: string | null;
  branch_name: string | null;
  pr_number: number | null;
  pr_base_branch: string | null;
  terminal_pr_number: number | null;
  worktree_path: string | null;
  review_iterations: number;
  feedback_iterations: number;
  spec_content: string | null;
  prior_context: string | null;
  delegator_account_id: string | null;
  open_question_count: number | null;
  created_at: string;
  updated_at: string;
}

interface PipelineRepoRow {
  issue_id: string;
  repo: string;
  in_scope: number;
  branch_name: string | null;
  pr_number: number | null;
  pr_base_branch: string | null;
  terminal_pr_number: number | null;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface BranchInfoUpdate {
  branchName?: string | null;
  prNumber?: number | null;
  prBaseBranch?: string | null;
  worktreePath?: string | null;
}

export type MergeTransitionResult =
  | "processed"
  | "already-processed"
  | "stale"
  | "missing"
  | "pending-others";

// Single source of truth for the merged-PR transition rules. The webhook's
// classifyMergedPrEvent (early exit, before side effects) and markPrMerged
// (transactional recheck at claim time) are intentionally layered — both must
// route through this predicate so the layers cannot drift.
export function classifyMergeTransition(
  row: { currentPhase: string | null; prNumber: number | null; terminalPrNumber: number | null },
  mergedPrNumber: number | null,
): "process" | "already-processed" | "stale" {
  if (row.currentPhase === "done" && row.prNumber === null) {
    if (mergedPrNumber === null || row.terminalPrNumber === mergedPrNumber) {
      return "already-processed";
    }
    return "stale";
  }
  if (
    mergedPrNumber !== null &&
    ((row.prNumber !== null && row.prNumber !== mergedPrNumber) ||
      (row.currentPhase !== "done" && row.terminalPrNumber === mergedPrNumber))
  ) {
    return "stale";
  }
  return "process";
}

// Per-row layer: a row whose PR was already nulled by its own terminal
// transition is "already processed" for that PR even while the issue waits on
// sibling repos; everything else defers to the issue-level rules.
export function classifyRepoMergeTransition(
  currentPhase: string | null,
  row: Pick<PipelineRepoRecord, "prNumber" | "terminalPrNumber">,
  mergedPrNumber: number | null,
): "process" | "already-processed" | "stale" {
  if (
    row.prNumber === null &&
    row.terminalPrNumber !== null &&
    (mergedPrNumber === null || row.terminalPrNumber === mergedPrNumber)
  ) {
    return "already-processed";
  }
  return classifyMergeTransition(
    { currentPhase, prNumber: row.prNumber, terminalPrNumber: row.terminalPrNumber },
    mergedPrNumber,
  );
}

export function firstInScopeRepo(repos: readonly PipelineRepoRecord[]): PipelineRepoRecord | null {
  return repos.find((r) => r.inScope) ?? null;
}

// The repo a single-row caller acts on: the first in-scope row, else the
// fallback (the config's first repo — the only repo in legacy mode).
export function primaryRepoName(record: Pick<PipelineRecord, "repos">, fallback: string): string {
  return firstInScopeRepo(record.repos)?.repo ?? fallback;
}

// --- Pipeline state store ---

export class PipelineStateStore {
  private readonly db: BetterSqlite3.Database;
  private readonly repoNames: string[];

  constructor(db: BetterSqlite3.Database, repoNames: readonly string[] = [DEFAULT_REPO_NAME]) {
    this.db = db;
    this.repoNames = [...repoNames];
  }

  get defaultRepo(): string {
    return this.repoNames[0] ?? DEFAULT_REPO_NAME;
  }

  create(
    issueId: string,
    initialPhase?: string,
    delegatorAccountId?: string | null,
  ): PipelineRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pipeline_state (issue_id, current_phase, delegator_account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(issueId, initialPhase ?? null, delegatorAccountId ?? null, now, now);
    const record = this.get(issueId);
    if (record === null) {
      throw new Error(`Failed to create pipeline record for issue ${issueId}`);
    }
    return record;
  }

  get(issueId: string): PipelineRecord | null {
    const row = this.db.prepare("SELECT * FROM pipeline_state WHERE issue_id = ?").get(issueId) as
      | PipelineRow
      | undefined;
    if (row === undefined) {
      return null;
    }
    return toPipelineRecord(row, this.listRepos(issueId));
  }

  listAll(): PipelineRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM pipeline_state ORDER BY updated_at DESC")
      .all() as PipelineRow[];
    const repoRows = this.db.prepare("SELECT * FROM pipeline_repos").all() as PipelineRepoRow[];
    const byIssue = new Map<string, PipelineRepoRecord[]>();
    for (const repoRow of repoRows) {
      const list = byIssue.get(repoRow.issue_id) ?? [];
      list.push(toRepoRecord(repoRow));
      byIssue.set(repoRow.issue_id, list);
    }
    return rows.map((row) =>
      toPipelineRecord(row, this.sortRepos(byIssue.get(row.issue_id) ?? [])),
    );
  }

  listRepos(issueId: string): PipelineRepoRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM pipeline_repos WHERE issue_id = ?")
      .all(issueId) as PipelineRepoRow[];
    return this.sortRepos(rows.map(toRepoRecord));
  }

  getRepo(issueId: string, repo: string): PipelineRepoRecord | null {
    const row = this.db
      .prepare("SELECT * FROM pipeline_repos WHERE issue_id = ? AND repo = ?")
      .get(issueId, repo) as PipelineRepoRow | undefined;
    return row === undefined ? null : toRepoRecord(row);
  }

  findByPr(repo: string, prNumber: number): PipelineRecord | null {
    const row = this.db
      .prepare("SELECT issue_id FROM pipeline_repos WHERE repo = ? AND pr_number = ?")
      .get(repo, prNumber) as { issue_id: string } | undefined;
    return row === undefined ? null : this.get(row.issue_id);
  }

  // Upserts in-scope rows for the named repos and descopes every other row.
  // Rows are never deleted here: a descoped row keeps its branch, PR, and
  // worktree so a human can close the orphaned PR.
  setScope(issueId: string, repoNames: readonly string[]): PipelineRepoRecord[] {
    return this.db.transaction((): PipelineRepoRecord[] => {
      this.assertRecord(issueId);
      const now = new Date().toISOString();
      const upsert = this.db.prepare(
        `INSERT INTO pipeline_repos (issue_id, repo, in_scope, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(issue_id, repo) DO UPDATE SET in_scope = 1, updated_at = excluded.updated_at`,
      );
      for (const name of repoNames) {
        upsert.run(issueId, name, now, now);
      }
      if (repoNames.length === 0) {
        this.db
          .prepare("UPDATE pipeline_repos SET in_scope = 0, updated_at = ? WHERE issue_id = ?")
          .run(now, issueId);
      } else {
        const placeholders = repoNames.map(() => "?").join(", ");
        this.db
          .prepare(
            `UPDATE pipeline_repos SET in_scope = 0, updated_at = ?
             WHERE issue_id = ? AND repo NOT IN (${placeholders})`,
          )
          .run(now, issueId, ...repoNames);
      }
      this.refreshMirror(issueId, now);
      return this.listRepos(issueId);
    })();
  }

  updateBranchInfo(issueId: string, repo: string, info: BranchInfoUpdate): PipelineRepoRecord {
    return this.db.transaction((): PipelineRepoRecord => {
      this.assertRecord(issueId);
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO pipeline_repos (issue_id, repo, in_scope, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(issue_id, repo) DO NOTHING`,
        )
        .run(issueId, repo, now, now);

      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (Object.prototype.hasOwnProperty.call(info, "branchName")) {
        sets.push("branch_name = ?");
        params.push(info.branchName ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(info, "prNumber")) {
        sets.push("pr_number = ?");
        params.push(info.prNumber ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(info, "prBaseBranch")) {
        sets.push("pr_base_branch = ?");
        params.push(info.prBaseBranch ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(info, "worktreePath")) {
        sets.push("worktree_path = ?");
        params.push(info.worktreePath ?? null);
      }
      if (sets.length > 0) {
        sets.push("updated_at = ?");
        params.push(now, issueId, repo);
        this.db
          .prepare(`UPDATE pipeline_repos SET ${sets.join(", ")} WHERE issue_id = ? AND repo = ?`)
          .run(...params);
      }
      this.refreshMirror(issueId, now);
      const updated = this.getRepo(issueId, repo);
      if (updated === null) {
        throw new Error(`Repo row ${issueId}/${repo} disappeared during updateBranchInfo`);
      }
      return updated;
    })();
  }

  updateBranch(issueId: string, repo: string, branchName: string): boolean {
    this.updateBranchInfo(issueId, repo, { branchName });
    return true;
  }

  updatePrNumber(
    issueId: string,
    repo: string,
    prNumber: number,
    prBaseBranch: string | null,
  ): boolean {
    this.updateBranchInfo(issueId, repo, { prNumber, prBaseBranch });
    return true;
  }

  updateWorktreePath(issueId: string, repo: string, worktreePath: string | null): boolean {
    this.updateBranchInfo(issueId, repo, { worktreePath });
    return true;
  }

  updatePhase(issueId: string, phase: string): boolean {
    const now = new Date().toISOString();
    // Shift the outgoing phase into prior_phase atomically. SQLite evaluates the
    // RHS against the pre-update row, so prior_phase captures current_phase as it
    // was before this transition. Every transition path funnels through here, so
    // a dispatched skill can read prior_phase to know what ran before it.
    const result = this.db
      .prepare(
        "UPDATE pipeline_state SET prior_phase = current_phase, current_phase = ?, updated_at = ? WHERE issue_id = ?",
      )
      .run(phase, now, issueId);
    return result.changes > 0;
  }

  markDone(issueId: string): boolean {
    return this.db.transaction((): boolean => {
      const state = this.db
        .prepare("SELECT current_phase FROM pipeline_state WHERE issue_id = ?")
        .get(issueId) as { current_phase: string | null } | undefined;
      if (state === undefined) {
        return false;
      }
      const now = new Date().toISOString();
      if (state.current_phase !== "done") {
        this.db
          .prepare(
            `UPDATE pipeline_repos SET terminal_pr_number = pr_number, updated_at = ?
             WHERE issue_id = ? AND in_scope = 1`,
          )
          .run(now, issueId);
        this.db
          .prepare(
            `UPDATE pipeline_state SET prior_phase = current_phase, current_phase = 'done', updated_at = ?
             WHERE issue_id = ?`,
          )
          .run(now, issueId);
      }
      this.refreshMirror(issueId, now);
      return true;
    })();
  }

  // Per-row terminal transition. The issue moves to done only inside the
  // transaction that merges the last in-scope row's PR; a descoped row's merge
  // transitions that row and nothing else.
  markPrMerged(
    issueId: string,
    repo: string,
    mergedPrNumber: number | null,
  ): MergeTransitionResult {
    return this.db.transaction((): MergeTransitionResult => {
      const state = this.db
        .prepare("SELECT current_phase FROM pipeline_state WHERE issue_id = ?")
        .get(issueId) as { current_phase: string | null } | undefined;
      const row = this.getRepo(issueId, repo);
      if (state === undefined || row === null) {
        return "missing";
      }
      const disposition = classifyRepoMergeTransition(state.current_phase, row, mergedPrNumber);
      if (disposition !== "process") {
        return disposition;
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE pipeline_repos
           SET terminal_pr_number = COALESCE(?, pr_number),
               pr_number = NULL,
               pr_base_branch = NULL,
               updated_at = ?
           WHERE issue_id = ? AND repo = ?`,
        )
        .run(mergedPrNumber, now, issueId, repo);
      const remaining = this.db
        .prepare(
          "SELECT COUNT(*) AS c FROM pipeline_repos WHERE issue_id = ? AND in_scope = 1 AND pr_number IS NOT NULL",
        )
        .get(issueId) as { c: number };
      if (row.inScope === false || remaining.c > 0) {
        this.refreshMirror(issueId, now);
        return "pending-others";
      }
      this.db
        .prepare(
          `UPDATE pipeline_state
           SET prior_phase = CASE WHEN current_phase = 'done' THEN prior_phase ELSE current_phase END,
               current_phase = 'done',
               updated_at = ?
           WHERE issue_id = ?`,
        )
        .run(now, issueId);
      this.refreshMirror(issueId, now);
      return "processed";
    })();
  }

  // Legacy-row adoption: pipeline_state rows that carry branch/PR/worktree/spec
  // state (or a terminal PR) but have no pipeline_repos rows get one row for the
  // config's first repo. spec_content counts because in legacy mode a written
  // spec implicitly targets the only repo. Idempotent.
  adoptLegacyRows(repoName: string): string[] {
    return this.db.transaction((): string[] => {
      const candidates = this.db
        .prepare(
          `SELECT issue_id FROM pipeline_state ps
           WHERE (branch_name IS NOT NULL OR pr_number IS NOT NULL OR worktree_path IS NOT NULL
                  OR spec_content IS NOT NULL OR terminal_pr_number IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM pipeline_repos pr WHERE pr.issue_id = ps.issue_id)
           ORDER BY issue_id`,
        )
        .all() as { issue_id: string }[];
      if (candidates.length === 0) {
        return [];
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO pipeline_repos
             (issue_id, repo, in_scope, branch_name, pr_number, pr_base_branch, terminal_pr_number, worktree_path, created_at, updated_at)
           SELECT issue_id, ?, 1, branch_name, pr_number, pr_base_branch, terminal_pr_number, worktree_path, created_at, ?
           FROM pipeline_state ps
           WHERE (branch_name IS NOT NULL OR pr_number IS NOT NULL OR worktree_path IS NOT NULL
                  OR spec_content IS NOT NULL OR terminal_pr_number IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM pipeline_repos pr WHERE pr.issue_id = ps.issue_id)`,
        )
        .run(repoName, now);
      return candidates.map((c) => c.issue_id);
    })();
  }

  incrementReviewIterations(issueId: string): number {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE pipeline_state SET review_iterations = review_iterations + 1, updated_at = ? WHERE issue_id = ?",
      )
      .run(now, issueId);
    const row = this.db
      .prepare("SELECT review_iterations FROM pipeline_state WHERE issue_id = ?")
      .get(issueId) as { review_iterations: number } | undefined;
    return row?.review_iterations ?? 0;
  }

  incrementFeedbackIterations(issueId: string): number {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE pipeline_state SET feedback_iterations = feedback_iterations + 1, updated_at = ? WHERE issue_id = ?",
      )
      .run(now, issueId);
    const row = this.db
      .prepare("SELECT feedback_iterations FROM pipeline_state WHERE issue_id = ?")
      .get(issueId) as { feedback_iterations: number } | undefined;
    return row?.feedback_iterations ?? 0;
  }

  resetIterations(issueId: string): boolean {
    const now = new Date().toISOString();
    // open_question_count is also cleared: it's a per-cycle signal set by
    // each spec-writing run, and a stale value left over from a previous
    // gate visit would mislead the skip-gate router.
    const result = this.db
      .prepare(
        `UPDATE pipeline_state SET
           review_iterations = 0,
           feedback_iterations = 0,
           open_question_count = NULL,
           updated_at = ?
         WHERE issue_id = ?`,
      )
      .run(now, issueId);
    return result.changes > 0;
  }

  resetReviewIterations(issueId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE pipeline_state SET review_iterations = 0, updated_at = ? WHERE issue_id = ?")
      .run(now, issueId);
    return result.changes > 0;
  }

  updateSpec(issueId: string, specContent: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE pipeline_state SET spec_content = ?, updated_at = ? WHERE issue_id = ?")
      .run(specContent, now, issueId);
    return result.changes > 0;
  }

  clearSpec(issueId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE pipeline_state SET spec_content = NULL, updated_at = ? WHERE issue_id = ?")
      .run(now, issueId);
    return result.changes > 0;
  }

  updatePriorContext(issueId: string, priorContext: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE pipeline_state SET prior_context = ?, updated_at = ? WHERE issue_id = ?")
      .run(priorContext, now, issueId);
    return result.changes > 0;
  }

  updateDelegator(issueId: string, accountId: string | null): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE pipeline_state SET delegator_account_id = ?, updated_at = ? WHERE issue_id = ?",
      )
      .run(accountId, now, issueId);
    return result.changes > 0;
  }

  setOpenQuestionCount(issueId: string, count: number | null): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE pipeline_state SET open_question_count = ?, updated_at = ? WHERE issue_id = ?",
      )
      .run(count, now, issueId);
    return result.changes > 0;
  }

  delete(issueId: string): boolean {
    return this.db.transaction((): boolean => {
      this.db.prepare("DELETE FROM pipeline_repos WHERE issue_id = ?").run(issueId);
      const result = this.db.prepare("DELETE FROM pipeline_state WHERE issue_id = ?").run(issueId);
      return result.changes > 0;
    })();
  }

  private assertRecord(issueId: string): void {
    const exists = this.db.prepare("SELECT 1 FROM pipeline_state WHERE issue_id = ?").get(issueId);
    if (exists === undefined) {
      throw new Error(`Cannot update branch info: no pipeline record for issue ${issueId}`);
    }
  }

  // Refresh the display-only scalar mirror from the first in-scope row. Called
  // inside every transaction that touches pipeline_repos.
  private refreshMirror(issueId: string, now: string): void {
    const first = firstInScopeRepo(this.listRepos(issueId));
    this.db
      .prepare(
        `UPDATE pipeline_state
         SET branch_name = ?, pr_number = ?, pr_base_branch = ?, terminal_pr_number = ?,
             worktree_path = ?, updated_at = ?
         WHERE issue_id = ?`,
      )
      .run(
        first?.branchName ?? null,
        first?.prNumber ?? null,
        first?.prBaseBranch ?? null,
        first?.terminalPrNumber ?? null,
        first?.worktreePath ?? null,
        now,
        issueId,
      );
  }

  private sortRepos(rows: PipelineRepoRecord[]): PipelineRepoRecord[] {
    const order = new Map(this.repoNames.map((name, index) => [name, index]));
    return [...rows].sort((a, b) => {
      const ia = order.get(a.repo) ?? Number.MAX_SAFE_INTEGER;
      const ib = order.get(b.repo) ?? Number.MAX_SAFE_INTEGER;
      if (ia !== ib) {
        return ia - ib;
      }
      return a.repo.localeCompare(b.repo);
    });
  }
}
```

and replace the trailing `toPipelineRecord` function with:

```ts
function toRepoRecord(row: PipelineRepoRow): PipelineRepoRecord {
  return {
    issueId: row.issue_id,
    repo: row.repo,
    inScope: row.in_scope === 1,
    branchName: row.branch_name,
    prNumber: row.pr_number,
    prBaseBranch: row.pr_base_branch,
    terminalPrNumber: row.terminal_pr_number,
    worktreePath: row.worktree_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPipelineRecord(row: PipelineRow, repos: PipelineRepoRecord[]): PipelineRecord {
  const primary = firstInScopeRepo(repos);
  return {
    issueId: row.issue_id,
    currentPhase: row.current_phase,
    priorPhase: row.prior_phase,
    branchName: primary?.branchName ?? null,
    prNumber: primary?.prNumber ?? null,
    prBaseBranch: primary?.prBaseBranch ?? null,
    terminalPrNumber: primary?.terminalPrNumber ?? null,
    worktreePath: primary?.worktreePath ?? null,
    reviewIterations: row.review_iterations,
    feedbackIterations: row.feedback_iterations,
    specContent: row.spec_content,
    priorContext: row.prior_context,
    delegatorAccountId: row.delegator_account_id,
    openQuestionCount: row.open_question_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    repos,
  };
}
```

Export `BranchInfoUpdate`, `PipelineRepoRecord` (via types), `classifyRepoMergeTransition`, `firstInScopeRepo`, `primaryRepoName`, `DEFAULT_REPO_NAME` from `src/index.ts` in the "Pipeline state" section.

- [ ] **Step 6: Keep callers compiling (primary-row selection)**

These are mechanical; plan 2 makes each site loop rows.

`src/webhook/server.ts`:

- line 373: `pipelineState.markPrMerged(event.issueId, mergedPrNumber)` → `pipelineState.markPrMerged(event.issueId, primaryRepoName(record, pipelineState.defaultRepo), mergedPrNumber)`, and change the following check to `if (transition !== "processed" && transition !== "pending-others") {` so the legacy single-row path still runs cleanup.
- line 656: `this.deps.pipelineState.updateBranchInfo(issueId, { branchName: null, worktreePath: null })` → add a `repo: string` parameter to `cleanupLocalBranchArtifacts` (after `issueId`) and call `updateBranchInfo(issueId, repo, {...})`; the two call sites pass `primaryRepoName(record, this.deps.pipelineState.defaultRepo)`.
- lines 714 and 735: `pipelineState.updateBranchInfo(rec.issueId, { prBaseBranch: mergedBase })` → `pipelineState.updateBranchInfo(rec.issueId, primaryRepoName(rec, pipelineState.defaultRepo), { prBaseBranch: mergedBase })`.
- Import `primaryRepoName` from `../core/pipeline-state.js`.

`src/cli/stack.ts:173`: `pipelineState.updateBranchInfo(issueId, primaryRepoName(pipelineState.get(issueId) ?? { repos: [] }, pipelineState.defaultRepo), { branchName: branch, worktreePath })` — write it as:

```ts
if (spec === false && branch !== null) {
  const existing = pipelineState.get(issueId) ?? pipelineState.create(issueId);
  pipelineState.updateBranchInfo(issueId, primaryRepoName(existing, pipelineState.defaultRepo), {
    branchName: branch,
    worktreePath,
  });
}
```

`src/cli/pipeline.ts:79` and `:151`, `src/cli/pr.ts:109`: same pattern — `const existing = ctx.pipelineState.get(issueId) ?? ctx.pipelineState.create(issueId);` then `updateBranchInfo(issueId, primaryRepoName(existing, ctx.pipelineState.defaultRepo), update)`. (Task 5 replaces these with `--repo`.) Note `updateBranchInfo` now returns a `PipelineRepoRecord`; `pipeline update` printed the full record — keep that by writing `writeJson(ctx.pipelineState.get(issueId), ...)` after the update.

Test helpers: add `repos: [],` to the `record()` literal in `src/core/__tests__/stack.test.ts` and `makeRecord()` in `src/core/__tests__/skill-context.test.ts`. Update the scalar-signature calls in `src/core/__tests__/orchestrator.test.ts` (8 sites, e.g. `h.pipelineState.updatePrNumber("PROJ-100", 77)` → `h.pipelineState.updatePrNumber("PROJ-100", "app", 77, null)`), `src/core/__tests__/orchestrator-stack.test.ts` (2), `src/cli/__tests__/stack.test.ts` (3; use `"app"`), `src/webhook/__tests__/server.test.ts` (11; use `"app"`), `src/__tests__/e2e/full-loop.test.ts` (1; use `"default"` — its source control is mock). Where a harness constructs `new PipelineStateStore(db)`, pass the config's repo names: `new PipelineStateStore(db.db, config.project.repos.map((r) => r.name))` (orchestrator harnesses build `config` first — move the store construction after it). For the webhook tests, `makeTestConfig()` yields repo name `app`, so construct `new PipelineStateStore(db, ["app"])`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/core/__tests__/pipeline-state.test.ts src/core/__tests__/database.test.ts src/core/__tests__/stack.test.ts src/core/__tests__/skill-context.test.ts src/core/__tests__/orchestrator.test.ts src/core/__tests__/orchestrator-stack.test.ts src/webhook/__tests__/server.test.ts src/cli/__tests__/stack.test.ts src/__tests__/e2e`
Expected: PASS.

- [ ] **Step 8: Check + commit**

```bash
npm run check
git add -A src/core src/webhook src/cli src/__tests__ src/index.ts
git commit -m "feat(state): pipeline_repos rows as the source of truth with a scalar mirror"
```

---

### Task 4: Source-control registry and adapter wiring

**Files:**

- Create: `src/integrations/source-control-registry.ts`
- Modify: `src/integrations/github/adapter.ts:24-29` (schema split)
- Modify: `src/cli/adapters.ts`
- Modify: `src/cli/context.ts`, `src/cli/start.ts`
- Modify: `src/core/orchestrator.ts` (deps, `start`, `handleSuccess`, `setupWebhookServer`, `reload`, `sourceControlRepoLabel`)
- Modify: `src/webhook/server.ts` (deps + adapter selection)
- Modify: `src/cli/pr.ts` (all `ctx.sourceControl` uses)
- Modify: `src/index.ts`
- Modify test harnesses: `src/core/__tests__/orchestrator.test.ts:105-120`, `orchestrator-stack.test.ts:87`, `orchestrator-reload.test.ts:193`, `runtime-state.test.ts:114`, `src/webhook/__tests__/server.test.ts:84` (+ the two other `new WebhookServer({...})` sites at ~576 and ~831), `src/__tests__/e2e/full-loop.test.ts:192`
- Test: `src/integrations/__tests__/source-control-registry.test.ts` (new), `src/cli/__tests__/adapters.test.ts` (new)

**Interfaces:**

- Produces:
  ```ts
  // src/integrations/source-control-registry.ts
  export interface SourceControlRegistryEntry { name: string; fullName: string; adapter: SourceControl }
  export interface SourceControlRegistry {
    get(repoName: string): SourceControl;                       // throws on unknown name, message lists valid names
    byFullName(fullName: string): SourceControlRegistryEntry | null; // "owner/repo", case-insensitive
    names(): string[];
    any(): SourceControl;                                       // first entry — shared secret / identity
  }
  export function createSourceControlRegistry(entries: readonly SourceControlRegistryEntry[]): SourceControlRegistry;
  export function repoFullName(repo: { name: string; owner: string; repo: string }): string; // "owner/repo" or name when either is empty
  // src/cli/adapters.ts
  export interface AdapterPair { issueTracker: IssueTracker; sourceControls: SourceControlRegistry; warmup: () => Promise<void> }
  export interface BuildAdaptersInput { ...existing; repos: readonly RepoConfig[]; workspaceMode: boolean }
  // src/integrations/github/adapter.ts
  export const GitHubSourceControlAuthSchema; // { auth?, webhookSecret? }
  export const GitHubSourceControlConfigSchema = GitHubSourceControlAuthSchema.extend({ owner, repo });
  ```
- `RedQueenDeps.sourceControl` → `sourceControls: SourceControlRegistry`; `WebhookServerDeps.sourceControl` → `sourceControls`; `CliContext.sourceControl` → `sourceControls`.

- [ ] **Step 1: Write the failing tests**

`src/integrations/__tests__/source-control-registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MockSourceControl } from "../../core/__tests__/fixtures/mock-adapters.js";
import { createSourceControlRegistry, repoFullName } from "../source-control-registry.js";

describe("createSourceControlRegistry", () => {
  const a = new MockSourceControl();
  const b = new MockSourceControl();
  const registry = createSourceControlRegistry([
    { name: "alignsmart", fullName: "AlignSmart/AlignSmart", adapter: a },
    { name: "app", fullName: "alignsmart/App", adapter: b },
  ]);

  it("resolves adapters by repo name", () => {
    expect(registry.get("app")).toBe(b);
    expect(registry.names()).toEqual(["alignsmart", "app"]);
    expect(registry.any()).toBe(a);
  });

  it("throws with the valid names on an unknown repo", () => {
    expect(() => registry.get("nope")).toThrow(/Unknown repo "nope".*alignsmart, app/);
  });

  it("resolves by full name case-insensitively", () => {
    expect(registry.byFullName("alignsmart/app")?.name).toBe("app");
    expect(registry.byFullName("ALIGNSMART/ALIGNSMART")?.adapter).toBe(a);
    expect(registry.byFullName("other/x")).toBeNull();
  });

  it("refuses an empty registry", () => {
    expect(() => createSourceControlRegistry([])).toThrow(/at least one/);
  });

  it("repoFullName falls back to the repo name when owner or repo is empty", () => {
    expect(repoFullName({ name: "default", owner: "", repo: "" })).toBe("default");
    expect(repoFullName({ name: "app", owner: "acme", repo: "App" })).toBe("acme/App");
  });
});
```

`src/cli/__tests__/adapters.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildAdapterPair } from "../adapters.js";
import { GitHubSourceControlAdapter } from "../../integrations/github/adapter.js";
import type { RepoConfig } from "../../core/config.js";

function repo(name: string, owner: string, repoName: string): RepoConfig {
  return {
    name,
    path: `/srv/${name}`,
    owner,
    repo: repoName,
    baseBranch: "origin/main",
    buildCommand: "b",
    testCommand: "t",
    modules: [],
  };
}

describe("buildAdapterPair", () => {
  it("builds one mock adapter per repo", () => {
    const pair = buildAdapterPair({
      issueTrackerType: "mock",
      issueTrackerConfig: {},
      sourceControlType: "mock",
      sourceControlConfig: {},
      repos: [repo("a", "o", "A"), repo("b", "o", "B")],
      workspaceMode: true,
    });
    expect(pair.sourceControls.names()).toEqual(["a", "b"]);
    expect(pair.sourceControls.get("a")).not.toBe(pair.sourceControls.get("b"));
    expect(pair.sourceControls.byFullName("o/B")?.name).toBe("b");
  });

  it("github/github workspace mode shares auth without an owner/repo equality check", () => {
    const pair = buildAdapterPair({
      issueTrackerType: "github-issues",
      issueTrackerConfig: { owner: "acme", repo: "Planning", auth: { type: "pat", token: "x" } },
      sourceControlType: "github",
      sourceControlConfig: { auth: { type: "pat", token: "x" } },
      repos: [repo("app", "acme", "App"), repo("web", "acme", "Web")],
      workspaceMode: true,
    });
    expect(pair.sourceControls.names()).toEqual(["app", "web"]);
    expect(pair.sourceControls.get("web")).toBeInstanceOf(GitHubSourceControlAdapter);
  });

  it("github/github legacy mode still requires the same owner/repo", () => {
    expect(() =>
      buildAdapterPair({
        issueTrackerType: "github-issues",
        issueTrackerConfig: { owner: "acme", repo: "Other", auth: { type: "pat", token: "x" } },
        sourceControlType: "github",
        sourceControlConfig: { owner: "acme", repo: "App", auth: { type: "pat", token: "x" } },
        repos: [repo("app", "acme", "App")],
        workspaceMode: false,
      }),
    ).toThrow(/same owner\/repo/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/integrations/__tests__/source-control-registry.test.ts src/cli/__tests__/adapters.test.ts`
Expected: FAIL — module not found / `repos` not accepted.

- [ ] **Step 3: Implement the registry**

Create `src/integrations/source-control-registry.ts`:

```ts
import type { SourceControl } from "./source-control.js";

export interface SourceControlRegistryEntry {
  name: string;
  fullName: string;
  adapter: SourceControl;
}

// One adapter per configured repo, all sharing one auth strategy. Adapters stay
// single-repo objects; callers that must pick a repo take the name from the
// pipeline repo row they are acting on.
export interface SourceControlRegistry {
  get(repoName: string): SourceControl;
  byFullName(fullName: string): SourceControlRegistryEntry | null;
  names(): string[];
  any(): SourceControl;
}

export function repoFullName(repo: { name: string; owner: string; repo: string }): string {
  return repo.owner !== "" && repo.repo !== "" ? `${repo.owner}/${repo.repo}` : repo.name;
}

export function createSourceControlRegistry(
  entries: readonly SourceControlRegistryEntry[],
): SourceControlRegistry {
  const first = entries[0];
  if (first === undefined) {
    throw new Error("SourceControlRegistry needs at least one repo");
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  const byFull = new Map(entries.map((e) => [e.fullName.toLowerCase(), e]));
  const names = entries.map((e) => e.name);
  return {
    get(repoName) {
      const entry = byName.get(repoName);
      if (entry === undefined) {
        throw new Error(`Unknown repo "${repoName}" — valid repos: ${names.join(", ")}`);
      }
      return entry.adapter;
    },
    byFullName(fullName) {
      return byFull.get(fullName.toLowerCase()) ?? null;
    },
    names() {
      return [...names];
    },
    any() {
      return first.adapter;
    },
  };
}
```

- [ ] **Step 4: Split the GitHub config schema**

In `src/integrations/github/adapter.ts` replace lines 24–29 with:

```ts
// Workspace mode carries only auth + webhookSecret under sourceControl.config;
// owner/repo come from project.repos[]. Legacy mode still has all four.
export const GitHubSourceControlAuthSchema = z.object({
  auth: GitHubAuthConfigSchema.optional(),
  webhookSecret: z.string().optional(),
});

export const GitHubSourceControlConfigSchema = GitHubSourceControlAuthSchema.extend({
  owner: z.string().min(1),
  repo: z.string().min(1),
});
```

`validateConfig` stays on the full schema; callers pass the shared block plus the repo's `owner`/`repo` (Step 6).

- [ ] **Step 5: Rewrite `buildAdapterPair`**

Replace the exported surface of `src/cli/adapters.ts` (keep `buildAuthStrategy`, `readPrivateKeyPem`, `pickPairedAuth`, `authsMatch` as they are):

```ts
import type { RepoConfig } from "../core/config.js";
import {
  GitHubSourceControlAdapter,
  GitHubSourceControlAuthSchema,
  GitHubSourceControlConfigSchema,
} from "../integrations/github/adapter.js";
import {
  createSourceControlRegistry,
  repoFullName,
} from "../integrations/source-control-registry.js";
import type { SourceControlRegistry } from "../integrations/source-control-registry.js";

export interface AdapterPair {
  issueTracker: IssueTracker;
  sourceControls: SourceControlRegistry;
  warmup: () => Promise<void>;
}

export interface BuildAdaptersInput {
  issueTrackerType: string;
  issueTrackerConfig: Record<string, unknown>;
  sourceControlType: string;
  sourceControlConfig: Record<string, unknown>;
  repos: readonly RepoConfig[];
  workspaceMode: boolean;
}

/**
 * Builds the tracker and one source-control adapter per repo. Both GitHub:
 * share one client + strategy across the tracker and every repo adapter.
 */
export function buildAdapterPair(
  input: BuildAdaptersInput,
  options: BuildAdaptersOptions = {},
): AdapterPair {
  if (input.issueTrackerType === "github-issues" && input.sourceControlType === "github") {
    const githubIssues = GitHubIssuesConfigSchema.parse(input.issueTrackerConfig);
    const githubSc = GitHubSourceControlAuthSchema.parse(input.sourceControlConfig);
    if (input.workspaceMode === false) {
      // Legacy pairing rule: the single repo is the issue repo. Workspace mode
      // drops this — the issue repo need not appear in repos[].
      const legacySc = GitHubSourceControlConfigSchema.parse(input.sourceControlConfig);
      if (githubIssues.owner !== legacySc.owner || githubIssues.repo !== legacySc.repo) {
        throw new CliError(
          "github-issues and github source control must use the same owner/repo — they're paired.",
        );
      }
    }
    const effectiveAuth = pickPairedAuth(githubIssues.auth, githubSc.auth);
    const strategy: GitHubAuthStrategy = buildAuthStrategy(effectiveAuth, options.configDir);
    const client = new GitHubClient({ auth: strategy });

    const sourceControls = buildGitHubRegistry(client, input.repos, githubSc.webhookSecret ?? null);
    const issueTracker = new GitHubIssuesAdapter({
      client,
      owner: githubIssues.owner,
      repo: githubIssues.repo,
      webhookSecret: githubIssues.webhookSecret ?? null,
      audit: options.audit,
    });
    return {
      issueTracker,
      sourceControls,
      warmup: async () => {
        await Promise.all([warmRegistry(sourceControls), issueTracker.warmIdentity()]);
      },
    };
  }

  const issueTracker = constructIssueTracker(
    input.issueTrackerType,
    input.issueTrackerConfig,
    options,
  );
  const sourceControls = constructSourceControls(
    input.sourceControlType,
    input.sourceControlConfig,
    input.repos,
    options,
  );

  const warmup = async (): Promise<void> => {
    const warmers: Promise<unknown>[] = [warmRegistry(sourceControls)];
    if (issueTracker instanceof JiraIssueTrackerAdapter) {
      warmers.push(issueTracker.warmIdentity());
    }
    if (issueTracker instanceof GitHubIssuesAdapter) {
      warmers.push(issueTracker.warmIdentity());
    }
    await Promise.all(warmers);
  };

  return { issueTracker, sourceControls, warmup };
}

export function constructSourceControls(
  type: string,
  config: Record<string, unknown>,
  repos: readonly RepoConfig[],
  options: BuildAdaptersOptions = {},
): SourceControlRegistry {
  if (type === "mock") {
    return createSourceControlRegistry(
      repos.map((repo) => ({
        name: repo.name,
        fullName: repoFullName(repo),
        adapter: new MockSourceControlAdapter(),
      })),
    );
  }
  if (type === "github") {
    const parsed = GitHubSourceControlAuthSchema.parse(config);
    const strategy = buildAuthStrategy(parsed.auth, options.configDir);
    const client = new GitHubClient({ auth: strategy });
    return buildGitHubRegistry(client, repos, parsed.webhookSecret ?? null);
  }
  throw new CliError(`Unknown sourceControl type: ${type}`);
}

function buildGitHubRegistry(
  client: GitHubClient,
  repos: readonly RepoConfig[],
  webhookSecret: string | null,
): SourceControlRegistry {
  return createSourceControlRegistry(
    repos.map((repo) => ({
      name: repo.name,
      fullName: repoFullName(repo),
      adapter: new GitHubSourceControlAdapter({
        client,
        owner: repo.owner,
        repo: repo.repo,
        webhookSecret,
      }),
    })),
  );
}

async function warmRegistry(registry: SourceControlRegistry): Promise<void> {
  const warmers: Promise<unknown>[] = [];
  for (const name of registry.names()) {
    const adapter = registry.get(name);
    if (adapter instanceof GitHubSourceControlAdapter) {
      warmers.push(adapter.warmIdentity());
    }
  }
  await Promise.all(warmers);
}
```

Delete the old `constructSourceControl` function. Keep `constructIssueTracker` unchanged.

- [ ] **Step 6: Wire the CLI entry points**

`src/cli/context.ts`:

```ts
import { resolveProjectPaths } from "../core/config.js";
import type { SourceControlRegistry } from "../integrations/source-control-registry.js";

export interface CliContext {
  config: RedQueenConfig;
  configPath: string;
  projectRoot: string;
  issueTracker: IssueTracker;
  sourceControls: SourceControlRegistry;
  pipelineState: PipelineStateStore;
  subIteration: SubIterationStore;
  audit: AuditLogger;
  cleanup: () => void;
}

export function loadCliContext(): CliContext {
  const loaded = loadConfigFromProject(process.cwd());
  const config = resolveProjectPaths(loaded.config, loaded.projectRoot);
  const projectDir = config.project.directory;
  const dbPath = resolve(projectDir, ".redqueen", "redqueen.db");
  const auditPath = resolve(projectDir, ".redqueen", config.audit.logFile);

  const database = new RedQueenDatabase(dbPath);
  const repoNames = config.project.repos.map((r) => r.name);
  const pipelineState = new PipelineStateStore(database.db, repoNames);
  const subIteration = new SubIterationStore(database.db);
  const audit = new DualWriteAuditLogger(database.db, auditPath);
  // Helpers may run before the first `start` on an upgraded install; adopt
  // legacy rows here too so per-row reads see them. Idempotent.
  const primary = repoNames[0];
  if (primary !== undefined) {
    pipelineState.adoptLegacyRows(primary);
  }

  const pair = buildAdapterPair(
    {
      issueTrackerType: config.issueTracker.type,
      issueTrackerConfig: config.issueTracker.config,
      sourceControlType: config.sourceControl.type,
      sourceControlConfig: config.sourceControl.config,
      repos: config.project.repos,
      workspaceMode: config.project.workspaceMode,
    },
    {
      configDir: loaded.configDir,
      audit: (message, metadata) => {
        audit.log({ component: "github-issues", issueId: null, message, metadata });
      },
    },
  );

  return {
    config,
    configPath: loaded.configPath,
    projectRoot: loaded.projectRoot,
    issueTracker: pair.issueTracker,
    sourceControls: pair.sourceControls,
    pipelineState,
    subIteration,
    audit,
    cleanup: () => {
      database.close();
    },
  };
}
```

`src/cli/start.ts`:

- line 50: keep `const projectDir = resolve(projectRoot, config.project.directory);`
- line 92: `const pipelineState = new PipelineStateStore(database.db, config.project.repos.map((r) => r.name));`
- lines 97–116: pass `repos: config.project.repos, workspaceMode: config.project.workspaceMode` in the input; `const { issueTracker, sourceControls } = adapterPair;`
- lines 129–137 become a per-repo loop:

```ts
for (const repo of config.project.repos) {
  try {
    sourceControls
      .get(repo.name)
      .validateConfig({ ...config.sourceControl.config, owner: repo.owner, repo: repo.repo });
  } catch (err) {
    database.close();
    removePidFile(pidPath);
    throw new CliError(
      `sourceControl config invalid for repo ${repo.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```

- lines 185–189: `const configForRuntime = { ...resolveProjectPaths(config, projectRoot), audit: { ...config.audit, logFile: auditPath } };`
- line 217: `sourceControls,`

- [ ] **Step 7: Wire the orchestrator**

`src/core/orchestrator.ts`:

- Replace `import type { SourceControl } from "../integrations/source-control.js";` with `import type { SourceControlRegistry } from "../integrations/source-control-registry.js";` and `sourceControl: SourceControl;` in `RedQueenDeps` with `sourceControls: SourceControlRegistry;`.
- Add `import { basename } from "node:path";` (extend the existing `node:path` import: `import { basename, join } from "node:path";`).
- In `start()`, before `const startupMergeScan = ...` (line 152) insert:

```ts
this.adoptLegacyRepoRows();
```

and add the method next to `performCrashRecovery`:

```ts
  // Deterministic, idempotent, config-aware: legacy pipeline_state rows gain a
  // pipeline_repos row for the config's first repo so every per-row reader
  // sees in-flight tickets after an upgrade or an in-place conversion.
  private adoptLegacyRepoRows(): void {
    const primary = this.deps.runtime.config.project.repos[0];
    if (primary === undefined) {
      return;
    }
    const adopted = this.deps.pipelineState.adoptLegacyRows(primary.name);
    if (adopted.length > 0) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId: null,
        message: `Adopted ${String(adopted.length)} legacy pipeline record(s) into repo ${primary.name}`,
        metadata: { repo: primary.name, issueIds: adopted },
      });
    }
  }
```

- Replace the `requiresPr` block in `handleSuccess` (lines 1562–1577) with:

```ts
if (phase.requiresPr === true) {
  const record = this.deps.pipelineState.get(issueId);
  for (const row of record?.repos ?? []) {
    if (row.inScope === false || row.prNumber === null) {
      continue;
    }
    try {
      await this.deps.sourceControls.get(row.repo).dismissStaleReviews(row.prNumber);
    } catch (err) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `dismissStaleReviews failed after ${phase.name}: ${errorMessage(err)}`,
        metadata: { taskId: task.id, repo: row.repo, prNumber: row.prNumber },
      });
    }
  }
}
```

- `setupWebhookServer`: `sourceControls: this.deps.sourceControls,`.
- `reload()`: after the `sourceControl` comparison add:

```ts
if (JSON.stringify(oldConfig.project.repos) !== JSON.stringify(newConfig.project.repos)) {
  restartRequired.push("project.repos");
}
```

- Replace `sourceControlRepoLabel` (lines 2316–2330):

```ts
// Cosmetic header label: the workspace root's basename in workspace mode, the
// single repo's owner/repo in legacy mode.
function sourceControlRepoLabel(config: RedQueenConfig): string | undefined {
  if (config.project.workspaceMode) {
    return basename(config.project.directory);
  }
  const repo = config.project.repos[0];
  if (repo === undefined) {
    return undefined;
  }
  if (repo.owner !== "" && repo.repo !== "") {
    return `${repo.owner}/${repo.repo}`;
  }
  return repo.repo !== "" ? repo.repo : undefined;
}
```

- [ ] **Step 8: Wire the webhook server (primary-row selection; plan 2 loops rows)**

`src/webhook/server.ts`:

- Imports: replace `import type { PullRequest, SourceControl } from "../integrations/source-control.js";` with `import type { PullRequest } from "../integrations/source-control.js";` and add `import type { SourceControlRegistry } from "../integrations/source-control-registry.js";`.
- `WebhookServerDeps.sourceControl: SourceControl` → `sourceControls: SourceControlRegistry`.
- `handleSourceControl`: `validate: (headers, body) => this.deps.sourceControls.any().validateWebhook(headers, body)` and `parse: ... this.deps.sourceControls.any().parseWebhookEvent(headers, body)`. (All adapters share the secret and identity.)
- Add a private helper:

```ts
  // The adapter for a record's primary row. Plan 2 replaces the single-row
  // callers with per-row loops; until then legacy installs have exactly one row.
  private adapterFor(record: Pick<PipelineRecord, "repos">): SourceControl {
    return this.deps.sourceControls.get(
      primaryRepoName(record, this.deps.pipelineState.defaultRepo),
    );
  }
```

(re-add `import type { SourceControl } from "../integrations/source-control.js";` for the return type.)

- `runMergedPrScan`: `const { pipelineState } = this.deps;` and `sourceControl.getPullRequest(prNumber)` → `this.adapterFor(record).getPullRequest(prNumber)`.
- `retargetAndRefreshDependents`: `const { pipelineState, queue, audit } = this.deps;` and both `sourceControl.` calls → `this.adapterFor(rec).`.
- `refreshDependentBranch`: `const { audit } = this.deps;` and `sourceControl.postPrComment(...)` → `this.deps.sourceControls.get(repo).postPrComment(...)` where `repo` is a new parameter added after `issueId` (`repo: string`); the caller passes `primaryRepoName(rec, this.deps.pipelineState.defaultRepo)`.

- [ ] **Step 9: Wire `pr.ts`**

In every subcommand replace `ctx.sourceControl.` with `ctx.sourceControls.get(ctx.pipelineState.defaultRepo).` (Task 5 replaces this with `--repo`).

- [ ] **Step 10: Update test harnesses and exports**

In each harness (`orchestrator.test.ts`, `orchestrator-stack.test.ts`, `orchestrator-reload.test.ts`, `runtime-state.test.ts`, `webhook/__tests__/server.test.ts` ×3, `e2e/full-loop.test.ts`):

```ts
import { createSourceControlRegistry } from "../../integrations/source-control-registry.js"; // adjust relative path
// where the deps object is built:
sourceControls: createSourceControlRegistry([
  { name: "app", fullName: "acme/app", adapter: sourceControl },
]),
```

Use `name: "default", fullName: "default"` in the e2e harness (mock source control → synthesized name `default`). Keep the `sourceControl` mock variable so existing assertions on `sourceControl.calls` keep working.

`src/index.ts`: add

```ts
export type {
  SourceControlRegistry,
  SourceControlRegistryEntry,
} from "./integrations/source-control-registry.js";
export {
  createSourceControlRegistry,
  repoFullName,
} from "./integrations/source-control-registry.js";
```

- [ ] **Step 11: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 12: Check + commit**

```bash
npm run check
git add -A src
git commit -m "feat(adapters): one source-control adapter per repo behind a registry sharing auth"
```

---

### Task 5: `--repo` on `pr *` and `pipeline update`

**Files:**

- Create: `src/cli/repo-arg.ts`
- Modify: `src/cli/pr.ts`, `src/cli/pipeline.ts`, `src/cli/help.ts` (lines 24–32)
- Test: `src/cli/__tests__/repo-arg.test.ts` (new), `src/cli/__tests__/helpers.test.ts`

**Interfaces:**

- Produces: `export function resolveRepoArg(config: RedQueenConfig, raw: string | undefined, cmd: string): RepoConfig` — required in workspace mode; defaults to the sole repo in legacy mode; unknown name is a `CliError` listing valid names.

- [ ] **Step 1: Write the failing tests**

`src/cli/__tests__/repo-arg.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeTestConfig } from "../../core/__tests__/fixtures/test-config.js";
import { resolveRepoArg } from "../repo-arg.js";
import type { RepoConfig } from "../../core/config.js";

function repo(name: string): RepoConfig {
  return {
    name,
    path: `/srv/${name}`,
    owner: "o",
    repo: name,
    baseBranch: "origin/main",
    buildCommand: "b",
    testCommand: "t",
    modules: [],
  };
}

describe("resolveRepoArg", () => {
  const workspace = makeTestConfig({ project: { repos: [repo("a"), repo("b")] } });
  const legacy = makeTestConfig();

  it("defaults to the sole repo in legacy mode", () => {
    expect(resolveRepoArg(legacy, undefined, "pr diff").name).toBe("app");
  });

  it("requires --repo in workspace mode", () => {
    expect(() => resolveRepoArg(workspace, undefined, "pr diff")).toThrow(
      /--repo <name> is required.*a, b/,
    );
  });

  it("resolves a known name and rejects unknown ones with the valid list", () => {
    expect(resolveRepoArg(workspace, "b", "pr diff").name).toBe("b");
    expect(() => resolveRepoArg(workspace, "zzz", "pr diff")).toThrow(/unknown repo "zzz".*a, b/);
  });
});
```

Add to `src/cli/__tests__/helpers.test.ts` inside `describe("cmdPipeline update + cleanup")`:

```ts
it("update writes the named repo row", async () => {
  await cmdPipeline(["update", "ISSUE-3", "--repo", "default", "--branch", "feature/ISSUE-3"]);
  const out = stdoutCapture.join("");
  const parsed = JSON.parse(out) as { repos: { repo: string; branchName: string }[] };
  expect(parsed.repos).toEqual([
    expect.objectContaining({ repo: "default", branchName: "feature/ISSUE-3" }),
  ]);
});

it("update rejects an unknown --repo", async () => {
  await expect(
    cmdPipeline(["update", "ISSUE-4", "--repo", "nope", "--branch", "b"]),
  ).rejects.toThrow(/unknown repo "nope"/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/__tests__/repo-arg.test.ts src/cli/__tests__/helpers.test.ts`
Expected: FAIL — module missing / `--repo` unknown option.

- [ ] **Step 3: Implement**

`src/cli/repo-arg.ts`:

```ts
import type { RedQueenConfig, RepoConfig } from "../core/config.js";
import { CliError } from "./errors.js";

// PR numbers collide across repos, so every helper that touches a PR or a repo
// row names its repo. Legacy installs have one repo and may omit the flag.
export function resolveRepoArg(
  config: RedQueenConfig,
  raw: string | undefined,
  cmd: string,
): RepoConfig {
  const repos = config.project.repos;
  const valid = repos.map((r) => r.name).join(", ");
  if (raw === undefined) {
    const sole = repos[0];
    if (config.project.workspaceMode || sole === undefined) {
      throw new CliError(`${cmd}: --repo <name> is required in workspace mode (valid: ${valid})`);
    }
    return sole;
  }
  const found = repos.find((r) => r.name === raw);
  if (found === undefined) {
    throw new CliError(`${cmd}: unknown repo "${raw}" — valid: ${valid}`);
  }
  return found;
}
```

`src/cli/pipeline.ts` — `cmdPipelineUpdate`: add `repo: { type: "string" }` to the options; after `loadCliContext()`:

```ts
const ctx = loadCliContext();
try {
  const repo = resolveRepoArg(ctx.config, values.repo, "pipeline update");
  if (ctx.pipelineState.get(issueId) === null) {
    ctx.pipelineState.create(issueId);
  }
  ctx.pipelineState.updateBranchInfo(issueId, repo.name, update);
  ctx.audit.log({
    component: "helper:pipeline",
    issueId,
    message: `Updated pipeline state for ${repo.name}: ${Object.keys(update).join(", ") || "(no-op)"}`,
    metadata: { ...update, repo: repo.name },
  });
  writeJson(ctx.pipelineState.get(issueId), values.pretty === true);
} finally {
  ctx.cleanup();
}
```

`pipeline cleanup` keeps the primary-row selection from Task 3 (plan 2 makes it per row).

`src/cli/pr.ts`: add `repo: { type: "string" }` to every subcommand's `options` (for `diff`, `checks`, `review`, `reviews`, `comments`, `comment`, `reply`, `create`). Add at the top of each subcommand's `try` block:

```ts
const repo = resolveRepoArg(ctx.config, values.repo, "pr <sub>");
const sourceControl = ctx.sourceControls.get(repo.name);
```

(`cmdPrDiff` currently has no `options` — add `options: { repo: { type: "string" } }` to its `parseArgs`.) Replace `ctx.sourceControls.get(ctx.pipelineState.defaultRepo).` with `sourceControl.`. In `cmdPrCreate`, the stack recompute stays as is for now (plan 2 makes the base per repo); write the row with:

```ts
if (ctx.pipelineState.get(issueId) === null) {
  ctx.pipelineState.create(issueId);
}
ctx.pipelineState.updateBranchInfo(issueId, repo.name, {
  branchName: head,
  prNumber: pr.number,
  prBaseBranch: resolvedBase,
});
```

and include `repo: repo.name` in the audit metadata.

`src/cli/help.ts`: update the helper lines:

```
  pr create                   Create a PR (--issue --head --base --title [--repo], body via stdin)
  pr diff <number>            Print the PR diff (--repo <name> in workspace mode)
  pr checks <number>          Print CI check status (--wait <seconds>) [--repo]
  pr review <number>          Post a review (--verdict, body via stdin) [--repo]
  pr reviews <number>         List reviews as JSON (--latest for the most recent) [--repo]
  pr comments <number>        List review comments as JSON [--repo]
  pr comment <number>         Post a PR-level comment (--body or stdin) [--repo]
  pr reply <number> <id>      Reply to a review comment (--body or stdin) [--repo]
  pipeline update <issueId>   Update a repo row (--repo --branch --pr --worktree --clear-pr --clear-worktree)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli`
Expected: PASS.

- [ ] **Step 5: Check + commit**

```bash
npm run check
git add src/cli
git commit -m "feat(cli): --repo on pr and pipeline update so PR numbers resolve per repo"
```

---

### Task 6: Skill context `repos` key with scalar fallbacks

**Files:**

- Modify: `src/core/types.ts` (`SkillContext`, new `SkillContextRepo`)
- Modify: `src/core/skill-context.ts` (`SkillContextDeps`, `buildSkillContext`)
- Modify: `src/skills/README.md` (contract table)
- Modify: `src/index.ts` (export `SkillContextRepo`)
- Test: `src/core/__tests__/skill-context.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export interface SkillContextRepo {
    name: string;
    path: string;
    baseBranch: string;
    buildCommand: string;
    testCommand: string;
    inScope: boolean;
    branchName: string | null;
    prNumber: number | null;
    module: SkillModuleContext | null;
    stackPrBase?: string;
  }
  // SkillContext gains: repos?: SkillContextRepo[]   (workspace mode only)
  // SkillContextDeps gains: repoPrBases?: Record<string, string>  (plan 2 fills it from per-repo stack resolution)
  ```
- Consumes: `RedQueenConfig.project.repos/workspaceMode` (Task 2), `PipelineRecord.repos` (Task 3).

- [ ] **Step 1: Write the failing tests**

Append to `src/core/__tests__/skill-context.test.ts` (add `import type { RepoConfig } from "../config.js";` and `import type { PipelineRepoRecord } from "../types.js";`):

```ts
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
    worktreePath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildSkillContext workspace mode", () => {
  it("omits repos entirely in legacy mode so the rendered block is byte-identical", () => {
    const context = buildSkillContext({
      runtime: makeRuntime(),
      task: makeTask(),
      pipelineRecord: makeRecord(),
      phaseName: "coding",
    });
    expect("repos" in context).toBe(false);
    expect(renderSkillPrompt(context, "# skill\n")).not.toContain("repos:");
  });

  it("lists every configured repo with scope, branch, PR and per-repo module", () => {
    const runtime = makeRuntime({
      project: {
        directory: "/srv/ws",
        repos: [
          repoCfg("api", {
            modules: [
              {
                name: "core",
                paths: ["src/**"],
                buildCommand: "build core",
                testCommandTargeted: "test core",
              },
            ],
          }),
          repoCfg("web", { baseBranch: "origin/develop" }),
        ],
        workspaceMode: true,
      },
    });
    const record = makeRecord({
      repos: [
        repoRow("api", {
          branchName: "feature/PROJ-1",
          prNumber: 42,
          worktreePath: "/srv/ws/.redqueen/worktrees/PROJ-1/api",
        }),
        repoRow("web", { inScope: false }),
      ],
    });
    const seen: string[] = [];
    const context = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: record,
      phaseName: "coding",
      resolveModule: (worktreePath, baseBranch) => {
        seen.push(`${worktreePath ?? "null"}|${baseBranch}`);
        return {
          buildCommand: "build core",
          testCommandTargeted: "test core",
          testCommandFull: null,
        };
      },
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
        module: {
          buildCommand: "build core",
          testCommandTargeted: "test core",
          testCommandFull: null,
        },
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
        module: null,
      },
    ]);
    // Only repos with modules call the resolver, with that repo's worktree and base.
    expect(seen).toEqual(["/srv/ws/.redqueen/worktrees/PROJ-1/api|origin/main"]);
    // Scalars degrade to the first in-scope repo.
    expect(context.buildCommands).toBe("build api");
    expect(context.testCommands).toBe("test api");
    expect(context.baseBranch).toBe("origin/main");
    expect(context.repoOwner).toBe("acme");
    expect(context.repoName).toBe("api");
    expect(context.branchName).toBe("feature/PROJ-1");
    expect(context.prNumber).toBe(42);
    expect(context.projectDir).toBe("/srv/ws");
  });

  it("falls back to repos[0] for the scalars before scope is set", () => {
    const runtime = makeRuntime({
      project: {
        directory: "/srv/ws",
        repos: [repoCfg("api"), repoCfg("web")],
        workspaceMode: true,
      },
    });
    const context = buildSkillContext({
      runtime,
      task: makeTask(),
      pipelineRecord: makeRecord({ repos: [] }),
      phaseName: "spec-writing",
    });
    expect(context.repos?.every((r) => r.inScope === false)).toBe(true);
    expect(context.buildCommands).toBe("build api");
    expect(context.repos?.[0]).not.toHaveProperty("stackPrBase");
  });
});
```

Also update the existing "calls the module resolver when project.modules is set" test: its record must carry the worktree on a row, so change `pipelineRecord: makeRecord({ worktreePath: "/tmp/worktree" })` to `pipelineRecord: makeRecord({ worktreePath: "/tmp/worktree", repos: [repoRow("app", { worktreePath: "/tmp/worktree" })] })` (the synthesized legacy repo for `makeTestConfig` is named `app`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/__tests__/skill-context.test.ts`
Expected: FAIL — `repos` / `repoPrBases` unknown.

- [ ] **Step 3: Implement**

`src/core/types.ts` — add before `SkillContext`:

```ts
// Workspace mode only: one entry per configured repo, in config order.
export interface SkillContextRepo {
  name: string;
  path: string;
  baseBranch: string;
  buildCommand: string;
  testCommand: string;
  inScope: boolean;
  branchName: string | null;
  prNumber: number | null;
  module: SkillModuleContext | null;
  // Stacked issues only: the branch this repo's PR must target.
  stackPrBase?: string;
}
```

and to `SkillContext` (after `projectDir`, before the stack keys):

```ts
  // Workspace mode only — omitted entirely in legacy mode so single-repo
  // prompts stay byte-identical. The scalar fields above then describe the
  // first in-scope repo (or repos[0] before scope is set).
  repos?: SkillContextRepo[];
```

`src/core/skill-context.ts` — extend `SkillContextDeps`:

```ts
  // Per-repo PR bases for stacked issues, keyed by repo name (plan 2 wires it).
  repoPrBases?: Record<string, string>;
```

and replace the body of `buildSkillContext` from `const scConfig = ...` (line 45) through the `return` with:

```ts
const branchPrefix = resolveBranchPrefix(config.pipeline.branchPrefixes, deps.issueType ?? null);

const resolver = deps.resolveModule ?? defaultResolveModule;
const rowsByRepo = new Map(pipelineRecord.repos.map((row) => [row.repo, row]));
const repoEntries = config.project.repos.map((repo): SkillContextRepo => {
  const row = rowsByRepo.get(repo.name) ?? null;
  const moduleContext =
    repo.modules.length > 0
      ? resolver(row?.worktreePath ?? null, repo.baseBranch, repo.modules)
      : null;
  const prBase = deps.repoPrBases?.[repo.name];
  return {
    name: repo.name,
    path: repo.path,
    baseBranch: repo.baseBranch,
    buildCommand: repo.buildCommand,
    testCommand: repo.testCommand,
    inScope: row?.inScope ?? false,
    branchName: row?.branchName ?? null,
    prNumber: row?.prNumber ?? null,
    module: moduleContext,
    ...(prBase !== undefined ? { stackPrBase: prBase } : {}),
  };
});
// Scalars describe the first in-scope repo so single-repo skills keep working;
// before scope is set (spec-writing) they describe repos[0].
const primaryIndex = Math.max(
  0,
  repoEntries.findIndex((r) => r.inScope),
);
const primary = repoEntries[primaryIndex];
const primaryConfig = config.project.repos[primaryIndex];
if (primary === undefined || primaryConfig === undefined) {
  throw new Error("config.project.repos is empty");
}

return {
  issueId,
  phaseName,
  phaseLabel: phase.label,
  skillName,
  buildCommands: primary.buildCommand,
  testCommands: primary.testCommand,
  repoOwner: primaryConfig.owner,
  repoName: primaryConfig.repo,
  baseBranch: primary.baseBranch,
  branchPrefix,
  module: primary.module,
  branchName: primary.branchName,
  prNumber: primary.prNumber,
  specContent: pipelineRecord.specContent,
  priorContext: pipelineRecord.priorContext,
  priorPhase: pipelineRecord.priorPhase,
  iterationCount: relevantIterationCount(phase, pipelineRecord),
  maxIterations,
  codebaseMapPath: deps.codebaseMapPath ?? null,
  projectDir: resolve(config.project.directory),
  // Conditional spreads: renderSkillPrompt YAML-dumps the whole object, so
  // omitting the keys keeps legacy and non-stacked prompts byte-identical.
  ...(config.project.workspaceMode ? { repos: repoEntries } : {}),
  ...(deps.stack != null
    ? {
        stackBlockedBy: deps.stack.directBlockers.map((b) => b.id),
        stackPrBase: deps.stack.prBase,
      }
    : {}),
};
```

Add `SkillContextRepo` to the `./types.js` type import. Export `SkillContextRepo` from `src/index.ts`.

Note on legacy behavior: `repoOwner`/`repoName` previously came from `sourceControl.config.owner/repo`; the synthesized legacy repo carries exactly those values (or `""`), so the rendered legacy context is unchanged. `module` previously resolved against `pipelineRecord.worktreePath` and `pipeline.baseBranch`; the legacy repo's row and `baseBranch` are the same values.

- [ ] **Step 4: Update the skills README contract table**

In `src/skills/README.md`, after the `stackPrBase` row add:

```
| `repos`           | `SkillContextRepo[]` _(omitted in legacy mode)_                | Workspace mode only: every configured repo, in config order — `{name, path, baseBranch, buildCommand, testCommand, inScope, branchName, prNumber, module, stackPrBase?}`. `path` is absolute. `inScope` is `false` for every repo until the prompt-writer runs `redqueen spec meta --repos`. |
```

and add this paragraph after the table:

```
**Workspace mode:** when `repos` is present, `buildCommands`, `testCommands`,
`baseBranch`, `repoOwner`, `repoName`, `module`, `branchName`, `prNumber`, and
`stackPrBase` are **deprecated** and describe only the first in-scope repo (or
`repos[0]` before scope is set). Multi-repo-aware skills loop over `repos`
instead. `projectDir` is the workspace root, which is not itself a git
repository — run git with `-C <repo.path>` or inside a worktree.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/core/__tests__/skill-context.test.ts src/core/__tests__/orchestrator-stack.test.ts`
Expected: PASS (the stack tests still see `stackPrBase: feature/1` at top level).

- [ ] **Step 6: Check + commit**

```bash
npm run check
git add src/core/types.ts src/core/skill-context.ts src/core/__tests__/skill-context.test.ts src/skills/README.md src/index.ts
git commit -m "feat(skill-context): per-repo context block in workspace mode, legacy block unchanged"
```

---

### Task 7: Wire `codebaseMapPath` into every dispatch

**Files:**

- Modify: `src/core/orchestrator.ts:1221-1229` (`buildSkillContext` call in `dispatchWorkerForTask`)
- Test: `src/core/__tests__/orchestrator.test.ts`

**Interfaces:**

- Consumes: `SkillContextDeps.codebaseMapPath` (existing, previously never passed).

- [ ] **Step 1: Write the failing test**

Append inside `describe("RedQueen orchestrator")` in `src/core/__tests__/orchestrator.test.ts` (uses the existing `setupHarness`, `runUntilAfterRuns`, `readDispatchedPrompt` helpers; `tempDir` is the project directory):

```ts
it("passes codebaseMapPath when .redqueen/codebase-map.md exists", async () => {
  mkdirSync(join(tempDir, ".redqueen"), { recursive: true });
  writeFileSync(join(tempDir, ".redqueen", "codebase-map.md"), "# map\n");
  const h = setupHarness(() =>
    Promise.resolve(
      makeWorkerResult({ success: true, exitCode: 0, elapsed: 1, summary: "ok", error: null }),
    ),
  );
  h.pipelineState.create("PROJ-MAP", "spec-writing");
  h.issueTracker.phases.set("PROJ-MAP", "spec-writing");
  h.issueTracker.specs.set("PROJ-MAP", "spec");
  h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-MAP" });

  await runUntilAfterRuns(h, 1);

  const prompt = readDispatchedPrompt(h.runs[0] as WorkerOptions);
  expect(prompt).toContain(`codebaseMapPath: ${join(tempDir, ".redqueen", "codebase-map.md")}`);
});

it("passes codebaseMapPath: null when the map is absent", async () => {
  const h = setupHarness(() =>
    Promise.resolve(
      makeWorkerResult({ success: true, exitCode: 0, elapsed: 1, summary: "ok", error: null }),
    ),
  );
  h.pipelineState.create("PROJ-NOMAP", "spec-writing");
  h.issueTracker.phases.set("PROJ-NOMAP", "spec-writing");
  h.issueTracker.specs.set("PROJ-NOMAP", "spec");
  h.queue.enqueue({ type: "spec-writing", issueId: "PROJ-NOMAP" });

  await runUntilAfterRuns(h, 1);

  expect(readDispatchedPrompt(h.runs[0] as WorkerOptions)).toContain("codebaseMapPath: null");
});
```

(`readDispatchedPrompt` reads the temp prompt file while the worker "runs"; the harness worker resolves immediately, and the file is unlinked in `finally`. If the first assertion flakes on the unlink race, capture the prompt inside the worker impl instead: `setupHarness((opts) => { captured = readDispatchedPrompt(opts); return Promise.resolve(...) })` — the existing tests in this file use both patterns.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/__tests__/orchestrator.test.ts -t codebaseMapPath`
Expected: FAIL — first test sees `codebaseMapPath: null`.

- [ ] **Step 3: Implement**

In `src/core/orchestrator.ts` `dispatchWorkerForTask`, replace the `buildSkillContext({...})` call with:

```ts
const codebaseMapPath = join(
  this.deps.runtime.config.project.directory,
  ".redqueen",
  "codebase-map.md",
);
const context = buildSkillContext({
  runtime: this.deps.runtime,
  task,
  pipelineRecord,
  phaseName: phase.name,
  issueType,
  codebaseMapPath: existsSync(codebaseMapPath) ? codebaseMapPath : null,
  resolveModule: this.moduleResolver,
  stack,
});
```

Add `existsSync` to the `node:fs` import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/__tests__/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Check + commit**

```bash
npm run check
git add src/core/orchestrator.ts src/core/__tests__/orchestrator.test.ts
git commit -m "fix(orchestrator): hand skills the codebase map init generates"
```

---

## Plan-level verification

- [ ] `npm run check` and `npx vitest run` both clean.
- [ ] Legacy smoke: in a scratch single-repo install (`redqueen init --yes` in a git repo with a `package.json`), `redqueen status` and `redqueen pipeline update X --branch b` work without `--repo`, and the rendered prompt for a dispatched phase contains no `repos:` key.
- [ ] Workspace smoke: a `redqueen.yaml` with two `repos[]` entries (paths pointing at two `git init`-ed directories) loads via `redqueen status`; `redqueen pr diff 1` without `--repo` fails with the valid-names message.
- [ ] Push the branch (`git push -u origin feat/multi-repo-workspace`).

## Self-review notes

- Spec §1 covered by Tasks 1–2 (schema, synthesis, validation, `loadConfig` path check, `RepoConfig` export). §2 by Task 4. §3 by Task 3 (table, per-row API, mirror, `findByPr`, adoption incl. `spec_content`; `markPrMerged` done-on-last + descoped-never-advances). §5 by Task 6. §6 by Task 6 (per-repo resolver calls; algorithm unchanged). Side finding by Task 7. Remaining §3 items (`rework-transition`, stack gate, `dismissStaleReviews` — done here) and §4, §7, §8 are plan 2.
- Type consistency: `updateBranchInfo(issueId, repo, info)` returns `PipelineRepoRecord` everywhere; `markPrMerged(issueId, repo, n)`; `PipelineStateStore(db, repoNames)`; registry `get/byFullName/names/any`; `SkillContextDeps.repoPrBases`.
