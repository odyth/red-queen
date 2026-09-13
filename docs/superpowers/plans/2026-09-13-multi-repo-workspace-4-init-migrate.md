# Multi-Repo Workspaces — Plan 4 of 5: Map, Init, Add-Repo, Migrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-09-13-multi-repo-workspace-design.md` §10 (workspace map), §11 (`init` fresh workspace), §12 (`init --add-repo`), §13 (`redqueen migrate`), Error handling. **Prerequisites:** plans 1–3 merged (`deriveRepoName`, `RepoConfig`, `parseConfig`/`loadConfig` workspace mode, `PipelineStateStore.adoptLegacyRows`, worktree layout).

**Goal:** A user can (a) scaffold a workspace in a parent folder of several git repos, (b) append a sibling repo to an existing install, and (c) move a single-repo install up one directory into workspace mode without losing in-flight worktrees or config comments — and the codebase map has one section per repo with edit-me blocks that survive regeneration.

**Architecture:** `codebase-map.ts` learns a sectioned format (`## Repo: <name>` blocks) and a section-aware merge; the flat legacy format stays. `init.ts` branches on "cwd is a git repo" (legacy init, unchanged) vs "cwd is not a repo but contains repo children" (workspace init). A new `repo-discovery.ts` holds the per-repo derivation (`deriveRepoEntry`) shared by workspace init, `--add-repo`, and `migrate`. `migrate.ts` is fail-fast: every precondition is checked before anything moves; worktrees move with `git worktree move`; the config is rewritten through the `yaml` Document API so comments survive.

**Tech Stack:** TypeScript, `yaml` (`parseDocument`/`setIn`/`toString`), `node:child_process` git, vitest with real git repos in temp dirs.

## Global Constraints

- Map: `<root>/.redqueen/codebase-map.md`, one `## Repo: <name>` section per repo containing `### What this repo is (edit me)` (seeded from the first paragraph of the repo's `README.md`, else a placeholder), generated `### Languages`, `### Commands`, `### Top-Level Layout`, `### Entry Points`, and `### Key Notes (edit me)`. `init --map-only` regenerates the generated parts per section and preserves both edit-me blocks. Legacy single-repo maps keep today's flat shape.
- `init` in a non-git directory with git-repo children → workspace mode: discover children, print them, prompt which to include (all with `--yes`), derive per repo (language, commands, `owner/repo` from `origin` via `parseGitRemote`, base branch from `origin/HEAD`), tracker/auth prompts once, write `project.repos[]`, `.redqueen/`, the map. Preflight: each chosen path is a git work tree with an `origin` remote. Root gets a `.gitignore` block only if it is itself a git repo. `init` in a git repo → today's single-repo init, unchanged.
- `init --add-repo <path>`: append one entry (name via `deriveRepoName`), add its map section; refuse duplicate name or path; in a legacy install first lift top-level fields into `repos[0]` (same transform as migrate step 5); config edits use `parseDocument` so comments, key order, tuned phases, pricing, and `jira discover` output survive.
- `redqueen migrate` (`--dry-run`, `--yes` only): preconditions (cwd has `redqueen.yaml` and is a git work tree root; `project.directory` resolves to cwd; orchestrator not running via pid file; `<parent>/redqueen.yaml` and `<parent>/.redqueen` absent; git ≥ 2.17); print plan; move registered worktrees with `git worktree move` to the nested layout (spec- prefix kept; stale `refresh-*` removed with `--force`); move remaining `.redqueen/*`, `redqueen.yaml`, `.env`; rewrite config (`repos[0]` with `name = deriveRepoName(repo)`, `path: ./<dirname>`, `baseBranch` from `pipeline.baseBranch`; update `service.workingDirectory` if set); prefix-swap `worktree_path` in `pipeline_state` **and** `pipeline_repos`, then run the adoption pass; reinstall the service unit if installed; print next steps (review config, `init --add-repo` per sibling, one webhook per sibling or an org webhook, `redqueen start`). Failure after step 3 prints which worktrees moved and the exact reverse `git worktree move` commands. Old repo's `.gitignore` block left in place.
- Style rules from plan 1; `npm run check` after every change.

---

## File Structure

| File                                  | Responsibility                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/cli/codebase-map.ts`             | `generateWorkspaceMap`, `mergeRegeneratedMap` (section-aware), `renderRepoSection`, `readmeSummary`                      |
| `src/cli/repo-discovery.ts` (new)     | `discoverRepoChildren`, `deriveRepoEntry`, `isGitWorkTreeRoot`, `readGitRemote`, `detectDefaultBranch` (moved from init) |
| `src/cli/init.ts`                     | Workspace init path; `--add-repo`; `--map-only` for both map shapes                                                      |
| `src/cli/config-edit.ts` (new)        | `liftLegacyToRepos(doc, dirname)`, `appendRepo(doc, entry)`, `writeYamlDocument` — shared Document edits                 |
| `src/cli/migrate.ts` (new)            | `cmdMigrate`, `planMigration`, `executeMigration`                                                                        |
| `src/cli/index.ts`, `src/cli/help.ts` | Register `migrate`; document `--add-repo`                                                                                |

---

### Task 1: Per-repo codebase map sections with section-aware regeneration

**Files:**

- Modify: `src/cli/codebase-map.ts`
- Test: `src/cli/__tests__/codebase-map.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export interface RepoMapInput {
    name: string;
    path: string;
    languages: LanguageDetection[];
    primary: LanguageKey;
    buildCommand: string;
    testCommand: string;
  }
  export interface WorkspaceMapInput {
    rootDir: string;
    repos: RepoMapInput[];
    generatedAt: string;
  }
  export function generateWorkspaceMap(input: WorkspaceMapInput): string;
  export function renderRepoSection(repo: RepoMapInput): string; // "## Repo: <name>" … "### Key Notes (edit me)" block
  export function readmeSummary(repoPath: string): string | null; // first paragraph of README.md
  export function mergeRegeneratedMap(existing: string, regenerated: string): string; // flat (unchanged) OR sectioned
  export function isWorkspaceMap(markdown: string): boolean; // has a "## Repo: " heading
  export const REPO_HEADING_RE: RegExp;
  ```
- The flat map (`generateCodebaseMap`) and its merge behavior stay byte-for-byte as today.

- [ ] **Step 1: Write the failing tests**

Append to `src/cli/__tests__/codebase-map.test.ts` (extend the import with `generateWorkspaceMap`, `readmeSummary`, `isWorkspaceMap`):

```ts
describe("generateWorkspaceMap", () => {
  it("writes one section per repo with both edit-me blocks", () => {
    mkdirSync(join(tmp, "api", "src"), { recursive: true });
    writeFileSync(join(tmp, "api", "package.json"), '{"main":"dist/index.js"}');
    writeFileSync(
      join(tmp, "api", "README.md"),
      "# API\n\nThe backend service.\nSecond line.\n\nMore.\n",
    );
    mkdirSync(join(tmp, "web"), { recursive: true });
    const map = generateWorkspaceMap({
      rootDir: tmp,
      generatedAt: "2026-09-13",
      repos: [
        {
          name: "api",
          path: join(tmp, "api"),
          languages: [{ key: "node-ts", displayName: "Node.js", markerFile: "package.json" }],
          primary: "node-ts",
          buildCommand: "npm run build",
          testCommand: "npm test",
        },
        {
          name: "web",
          path: join(tmp, "web"),
          languages: [],
          primary: "blank",
          buildCommand: "",
          testCommand: "",
        },
      ],
    });
    expect(map).toContain("# Workspace Map");
    expect(map).toContain("## Repo: api");
    expect(map).toContain("### What this repo is (edit me)\nThe backend service.\nSecond line.");
    expect(map).toContain("### Languages\n- Node.js (package.json detected)");
    expect(map).toContain("### Commands\n- **Build:** `npm run build`");
    expect(map).toContain("### Top-Level Layout\n- `README.md`\n- `package.json`\n- `src/`");
    expect(map).toContain("### Entry Points\n- `dist/index.js`");
    expect(map).toContain("### Key Notes (edit me)");
    expect(map).toContain("## Repo: web");
    expect(map).toContain(
      "### What this repo is (edit me)\n- (describe this repo — no README.md found)",
    );
    expect(isWorkspaceMap(map)).toBe(true);
    expect(isWorkspaceMap("# Codebase Map\n## Key Notes (edit me)\n")).toBe(false);
  });
});

describe("readmeSummary", () => {
  it("returns the first non-heading paragraph or null", () => {
    mkdirSync(join(tmp, "r"), { recursive: true });
    writeFileSync(
      join(tmp, "r", "README.md"),
      "# Title\n\n[badge](x)\n\nReal summary here.\n\nRest.\n",
    );
    expect(readmeSummary(join(tmp, "r"))).toBe("[badge](x)");
    expect(readmeSummary(join(tmp, "nope"))).toBeNull();
  });
});

describe("mergeRegeneratedMap (sectioned)", () => {
  const existing = [
    "# Workspace Map",
    "",
    "## Repo: api",
    "",
    "### What this repo is (edit me)",
    "Human-written purpose.",
    "",
    "### Languages",
    "- Python (pyproject.toml detected)",
    "",
    "### Key Notes (edit me)",
    "- api note.",
    "",
    "## Repo: web",
    "",
    "### What this repo is (edit me)",
    "Web purpose.",
    "",
    "### Languages",
    "- (none)",
    "",
    "### Key Notes (edit me)",
    "- web note.",
    "",
  ].join("\n");
  const regenerated = [
    "# Workspace Map",
    "",
    "## Repo: api",
    "",
    "### What this repo is (edit me)",
    "- (describe this repo — no README.md found)",
    "",
    "### Languages",
    "- Node.js (package.json detected)",
    "",
    "### Key Notes (edit me)",
    "- placeholder.",
    "",
    "## Repo: email",
    "",
    "### What this repo is (edit me)",
    "- (describe this repo — no README.md found)",
    "",
    "### Languages",
    "- Ruby (Gemfile detected)",
    "",
    "### Key Notes (edit me)",
    "- placeholder.",
    "",
  ].join("\n");

  it("keeps both edit-me blocks per repo, regenerates the rest, keeps new repos, drops removed ones", () => {
    const merged = mergeRegeneratedMap(existing, regenerated);
    expect(merged).toContain("### What this repo is (edit me)\nHuman-written purpose.");
    expect(merged).toContain("- Node.js (package.json detected)");
    expect(merged).not.toContain("Python");
    expect(merged).toContain("### Key Notes (edit me)\n- api note.");
    expect(merged).toContain("## Repo: email");
    expect(merged).toContain("- Ruby (Gemfile detected)");
    expect(merged).not.toContain("## Repo: web");
    expect(merged.indexOf("## Repo: api")).toBeLessThan(merged.indexOf("## Repo: email"));
  });

  it("still merges flat maps exactly as before", () => {
    const flatExisting =
      "# Codebase Map\n\n## Languages\n- Python\n\n## Key Notes (edit me)\n- keep me.\n";
    const flatRegen =
      "# Codebase Map\n\n## Languages\n- Node.js\n\n## Key Notes (edit me)\n- placeholder.\n";
    expect(mergeRegeneratedMap(flatExisting, flatRegen)).toBe(
      "# Codebase Map\n\n## Languages\n- Node.js\n\n## Key Notes (edit me)\n- keep me.\n",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/__tests__/codebase-map.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

Add to `src/cli/codebase-map.ts`:

```ts
const PURPOSE_HEADER = "### What this repo is (edit me)";
const REPO_KEY_NOTES_HEADER = "### Key Notes (edit me)";
export const REPO_HEADING_RE = /^## Repo: (.+)$/m;

export interface RepoMapInput {
  name: string;
  path: string;
  languages: LanguageDetection[];
  primary: LanguageKey;
  buildCommand: string;
  testCommand: string;
}

export interface WorkspaceMapInput {
  rootDir: string;
  repos: RepoMapInput[];
  generatedAt: string;
}

export function isWorkspaceMap(markdown: string): boolean {
  return REPO_HEADING_RE.test(markdown);
}

// First paragraph of README.md that is not a heading: the cheapest honest
// seed for "what this repo is". Returns null when there is no README.
export function readmeSummary(repoPath: string): string | null {
  const readme = join(repoPath, "README.md");
  if (existsSync(readme) === false) {
    return null;
  }
  let text: string;
  try {
    text = readFileSync(readme, "utf8");
  } catch {
    return null;
  }
  const paragraphs = text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "" && p.startsWith("#") === false);
  return paragraphs[0] ?? null;
}

export function renderRepoSection(repo: RepoMapInput): string {
  const purpose = readmeSummary(repo.path) ?? "- (describe this repo — no README.md found)";
  return [
    `## Repo: ${repo.name}`,
    "",
    PURPOSE_HEADER,
    purpose,
    "",
    "### Languages",
    renderLanguages(repo.languages),
    "",
    "### Commands",
    renderCommands(repo.buildCommand, repo.testCommand),
    "",
    "### Top-Level Layout",
    renderTopLevelLayout(repo.path),
    "",
    "### Entry Points",
    renderEntryPoints(repo.path, repo.primary),
    "",
    REPO_KEY_NOTES_HEADER,
    "- Describe the module structure here.",
    "- Note any unusual conventions the AI should know.",
    "",
  ].join("\n");
}

export function generateWorkspaceMap(input: WorkspaceMapInput): string {
  return [
    "# Workspace Map",
    "",
    `Generated by \`redqueen init\` on ${input.generatedAt}. One section per repo — edit the`,
    '"(edit me)" blocks freely; regenerate the rest with `redqueen init --map-only`.',
    "",
    ...input.repos.map(renderRepoSection),
  ].join("\n");
}
```

Replace `mergeRegeneratedMap` with a dispatcher plus the sectioned merge (keep the current flat implementation as `mergeFlatMap`):

```ts
export function mergeRegeneratedMap(existing: string, regenerated: string): string {
  if (isWorkspaceMap(regenerated)) {
    return mergeWorkspaceMap(existing, regenerated);
  }
  return mergeFlatMap(existing, regenerated);
}

function mergeFlatMap(existing: string, regenerated: string): string {
  const marker = KEY_NOTES_HEADER;
  const idx = existing.indexOf(marker);
  if (idx === -1) {
    throw new Error(
      `Cannot regenerate: '${marker}' marker not found in existing map. Edit manually or run 'redqueen init --force' to recreate.`,
    );
  }
  const regenIdx = regenerated.indexOf(marker);
  if (regenIdx === -1) {
    return regenerated;
  }
  // Keep everything after the marker (inclusive) from the existing file.
  const preserved = existing.slice(idx);
  const regenHead = regenerated.slice(0, regenIdx);
  return `${regenHead}${preserved}`;
}

interface RepoSection {
  name: string;
  body: string; // from the "## Repo:" line through the line before the next "## Repo:"
}

function splitRepoSections(markdown: string): { head: string; sections: RepoSection[] } {
  const lines = markdown.split("\n");
  const head: string[] = [];
  const sections: RepoSection[] = [];
  let current: RepoSection | null = null;
  for (const line of lines) {
    const match = /^## Repo: (.+)$/.exec(line);
    if (match?.[1] !== undefined) {
      current = { name: match[1].trim(), body: "" };
      sections.push(current);
    }
    if (current === null) {
      head.push(line);
    } else {
      current.body += `${line}\n`;
    }
  }
  return { head: head.join("\n"), sections };
}

// The text under a "### … (edit me)" heading up to the next "###"/"##" heading.
function editBlock(body: string, header: string): string | null {
  const start = body.indexOf(header);
  if (start === -1) {
    return null;
  }
  const after = body.slice(start + header.length);
  const next = /\n#{2,3} /.exec(after);
  return next === null ? after : after.slice(0, next.index + 1);
}

function replaceEditBlock(body: string, header: string, replacement: string): string {
  const start = body.indexOf(header);
  if (start === -1) {
    return body;
  }
  const after = body.slice(start + header.length);
  const next = /\n#{2,3} /.exec(after);
  const end = next === null ? body.length : start + header.length + next.index + 1;
  return `${body.slice(0, start + header.length)}${replacement}${body.slice(end)}`;
}

// Regenerated sections win; each repo's two edit-me blocks are carried over
// from the existing map. Repos absent from the regenerated map (removed from
// config) are dropped; new repos keep their placeholders.
function mergeWorkspaceMap(existing: string, regenerated: string): string {
  const old = new Map(splitRepoSections(existing).sections.map((s) => [s.name, s.body]));
  const regen = splitRepoSections(regenerated);
  const merged = regen.sections.map((section) => {
    const previous = old.get(section.name);
    if (previous === undefined) {
      return section.body;
    }
    let body = section.body;
    for (const header of [PURPOSE_HEADER, REPO_KEY_NOTES_HEADER]) {
      const kept = editBlock(previous, header);
      if (kept !== null) {
        body = replaceEditBlock(body, header, kept);
      }
    }
    return body;
  });
  return `${regen.head}${merged.join("")}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/__tests__/codebase-map.test.ts`
Expected: PASS (including the existing flat tests).

- [ ] **Step 5: Check + commit**

```bash
npm run check
git add src/cli/codebase-map.ts src/cli/__tests__/codebase-map.test.ts
git commit -m "feat(map): per-repo workspace map sections whose edit-me blocks survive regeneration"
```

---

### Task 2: Repo discovery + config Document edits (shared by init, add-repo, migrate)

**Files:**

- Create: `src/cli/repo-discovery.ts`
- Create: `src/cli/config-edit.ts`
- Modify: `src/cli/init.ts` (import `detectDefaultBranch`/`readGitRemote` from the new module instead of defining them)
- Test: `src/cli/__tests__/repo-discovery.test.ts`, `src/cli/__tests__/config-edit.test.ts`

**Interfaces:**

- Produces:

  ```ts
  // repo-discovery.ts
  export interface DiscoveredRepo {
    dirName: string;
    path: string;
    remote: string | null;
  }
  export function isGitWorkTreeRoot(dir: string): boolean; // `git rev-parse --show-toplevel` === dir
  export function readGitRemote(dir: string): string | null; // moved from init.ts
  export function detectDefaultBranch(dir: string): string | null; // moved from init.ts
  export function discoverRepoChildren(rootDir: string): DiscoveredRepo[]; // sorted by dirName
  export interface RepoEntryDerivation {
    entry: RepoConfig;
    languages: LanguageDetection[];
    primary: LanguageKey;
  }
  export function deriveRepoEntry(repoPath: string, rootDir: string): RepoEntryDerivation; // throws CliError without origin
  // config-edit.ts
  export function readYamlDocument(path: string): Document;
  export function writeYamlDocument(path: string, doc: Document): void; // atomic tmp+rename
  export function liftLegacyToRepos(doc: Document, repoPath: string): RepoConfig; // in-place; throws if already workspace
  export function appendRepo(doc: Document, entry: RepoConfig): void; // throws on duplicate name/path
  ```

  `deriveRepoEntry` writes `path` relative to `rootDir` as `./<rel>` (POSIX separators).

- [ ] **Step 1: Write the failing tests**

`src/cli/__tests__/repo-discovery.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveRepoEntry, discoverRepoChildren, isGitWorkTreeRoot } from "../repo-discovery.js";

let tmp: string;

function gitInit(dir: string, remote?: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q", { cwd: dir });
  if (remote !== undefined) {
    execSync(`git remote add origin ${remote}`, { cwd: dir });
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rq-discover-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("discoverRepoChildren", () => {
  it("lists direct children that are git work tree roots, sorted", () => {
    gitInit(join(tmp, "Zeta"), "git@github.com:acme/Zeta.git");
    gitInit(join(tmp, "alpha"));
    mkdirSync(join(tmp, "plain"));
    mkdirSync(join(tmp, ".hidden"));
    expect(discoverRepoChildren(tmp)).toEqual([
      { dirName: "Zeta", path: join(tmp, "Zeta"), remote: "git@github.com:acme/Zeta.git" },
      { dirName: "alpha", path: join(tmp, "alpha"), remote: null },
    ]);
    expect(isGitWorkTreeRoot(join(tmp, "plain"))).toBe(false);
    expect(isGitWorkTreeRoot(join(tmp, "alpha"))).toBe(true);
  });
});

describe("deriveRepoEntry", () => {
  it("derives name, owner/repo, commands, and a relative path", () => {
    const dir = join(tmp, "Email_Templates");
    gitInit(dir, "https://github.com/acme/Email_Templates.git");
    writeFileSync(join(dir, "package.json"), '{"scripts":{"build":"x","test":"y"}}');
    const { entry, primary } = deriveRepoEntry(dir, tmp);
    expect(entry).toEqual({
      name: "email-templates",
      path: "./Email_Templates",
      owner: "acme",
      repo: "Email_Templates",
      baseBranch: "origin/main",
      buildCommand: "npm run build",
      testCommand: "npm test",
      modules: [],
    });
    expect(primary).toBe("node-ts");
  });

  it("refuses a repo without an origin remote", () => {
    const dir = join(tmp, "NoRemote");
    gitInit(dir);
    expect(() => deriveRepoEntry(dir, tmp)).toThrow(/no 'origin' remote/);
  });
});
```

`src/cli/__tests__/config-edit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseDocument } from "yaml";
import { appendRepo, liftLegacyToRepos } from "../config-edit.js";
import { parseConfig } from "../../core/config.js";

const legacyYaml = [
  "# keep this comment",
  "issueTracker:",
  "  type: mock",
  "sourceControl:",
  "  type: github",
  "  config:",
  "    owner: acme # owner comment",
  "    repo: My_App",
  "    auth: { type: pat, token: tok }",
  "project:",
  "  buildCommand: npm run build",
  "  testCommand: npm test",
  "  modules:",
  "    - name: web",
  '      paths: ["web/**"]',
  "      buildCommand: b",
  "pipeline:",
  "  baseBranch: origin/develop",
  "  cost:",
  "    enabled: true",
  "",
].join("\n");

describe("liftLegacyToRepos", () => {
  it("moves top-level fields into repos[0], drops owner/repo, keeps comments and other keys", () => {
    const doc = parseDocument(legacyYaml);
    const entry = liftLegacyToRepos(doc, "./My_App");
    const out = doc.toString();
    expect(entry.name).toBe("my-app");
    expect(out).toContain("# keep this comment");
    expect(out).toContain("cost:\n    enabled: true");
    expect(out).not.toMatch(/^\s+owner: acme/m);
    expect(out).not.toMatch(/^  buildCommand:/m);
    const config = parseConfig(out);
    expect(config.project.workspaceMode).toBe(true);
    expect(config.project.repos).toEqual([
      {
        name: "my-app",
        path: "./My_App",
        owner: "acme",
        repo: "My_App",
        baseBranch: "origin/develop",
        buildCommand: "npm run build",
        testCommand: "npm test",
        modules: [{ name: "web", paths: ["web/**"], buildCommand: "b", testCommandTargeted: null }],
      },
    ]);
  });

  it("throws when the config is already in workspace mode", () => {
    const doc = parseDocument(legacyYaml);
    liftLegacyToRepos(doc, "./My_App");
    expect(() => liftLegacyToRepos(doc, "./My_App")).toThrow(/already in workspace mode/);
  });
});

describe("appendRepo", () => {
  const entry = {
    name: "web",
    path: "./Web",
    owner: "acme",
    repo: "Web",
    baseBranch: "origin/main",
    buildCommand: "npm run build",
    testCommand: "npm test",
    modules: [],
  };

  it("appends an entry and rejects duplicates by name or path", () => {
    const doc = parseDocument(legacyYaml);
    liftLegacyToRepos(doc, "./My_App");
    appendRepo(doc, entry);
    expect(parseConfig(doc.toString()).project.repos.map((r) => r.name)).toEqual(["my-app", "web"]);
    expect(() => appendRepo(doc, entry)).toThrow(/already declares repo "web"/);
    expect(() => appendRepo(doc, { ...entry, name: "other" })).toThrow(
      /already declares path "\.\/Web"/,
    );
  });

  it("omits baseBranch when it equals pipeline.baseBranch and omits empty modules", () => {
    const doc = parseDocument(legacyYaml);
    liftLegacyToRepos(doc, "./My_App");
    appendRepo(doc, { ...entry, baseBranch: "origin/develop" });
    const out = doc.toString();
    expect(out).not.toMatch(/name: web[\s\S]*baseBranch/);
    expect(out).not.toMatch(/name: web[\s\S]*modules/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/__tests__/repo-discovery.test.ts src/cli/__tests__/config-edit.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `repo-discovery.ts`**

```ts
import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { deriveRepoName } from "../core/config.js";
import type { RepoConfig } from "../core/config.js";
import { detectLanguages, parseGitRemote, suggestCommands } from "./detect.js";
import type { LanguageDetection, LanguageKey } from "./detect.js";
import { CliError } from "./errors.js";

export interface DiscoveredRepo {
  dirName: string;
  path: string;
  remote: string | null;
}

export function isGitWorkTreeRoot(dir: string): boolean {
  try {
    const top = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return resolve(top) === resolve(dir);
  } catch {
    return false;
  }
}

export function readGitRemote(dir: string): string | null {
  try {
    return execSync("git remote get-url origin", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function detectDefaultBranch(dir: string): string | null {
  try {
    const out = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (out.startsWith("refs/remotes/")) {
      return out.slice("refs/remotes/".length);
    }
  } catch {
    // fall through
  }
  // Without an origin remote `gh repo view` has nothing to resolve — skip the
  // spawn entirely. gh is a ~50MB binary; cold-loading it just to watch it fail
  // costs seconds on a loaded machine.
  if (readGitRemote(dir) === null) {
    return null;
  }
  try {
    const out = execSync(
      "gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null",
      { cwd: dir, encoding: "utf8", timeout: 5000 },
    ).trim();
    if (out.length > 0) {
      return `origin/${out}`;
    }
  } catch {
    // fall through
  }
  return null;
}

// Direct children of rootDir that are git work tree roots. Hidden dirs skipped.
export function discoverRepoChildren(rootDir: string): DiscoveredRepo[] {
  const found: DiscoveredRepo[] = [];
  for (const entry of readdirSync(rootDir).sort()) {
    if (entry.startsWith(".")) {
      continue;
    }
    const path = join(rootDir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir === false || isGitWorkTreeRoot(path) === false) {
      continue;
    }
    found.push({ dirName: entry, path, remote: readGitRemote(path) });
  }
  return found;
}

export interface RepoEntryDerivation {
  entry: RepoConfig;
  languages: LanguageDetection[];
  primary: LanguageKey;
}

// The one derivation used by workspace init, --add-repo, and migrate.
export function deriveRepoEntry(repoPath: string, rootDir: string): RepoEntryDerivation {
  if (isGitWorkTreeRoot(repoPath) === false) {
    throw new CliError(`${repoPath} is not a git work tree root`);
  }
  const remote = readGitRemote(repoPath);
  const parsed = remote === null ? null : parseGitRemote(remote);
  if (parsed === null) {
    throw new CliError(
      `${repoPath} has no 'origin' remote (or it is not a GitHub URL) — add one so owner/repo can be derived`,
    );
  }
  const languages = detectLanguages(repoPath);
  const primary: LanguageKey = languages[0]?.key ?? "blank";
  const suggested = suggestCommands(primary, repoPath);
  const rel = relative(rootDir, repoPath).split(sep).join("/");
  return {
    entry: {
      name: deriveRepoName(parsed.repo),
      path: rel.startsWith(".") ? rel : `./${rel}`,
      owner: parsed.owner,
      repo: parsed.repo,
      baseBranch: detectDefaultBranch(repoPath) ?? "origin/main",
      buildCommand: suggested.build.length > 0 ? suggested.build : "npm run build",
      testCommand: suggested.test.length > 0 ? suggested.test : "npm test",
      modules: [],
    },
    languages,
    primary,
  };
}
```

In `src/cli/init.ts` delete the private `detectDefaultBranch` and `readGitRemote` functions and import them from `./repo-discovery.js` (the `--yes` and interactive paths keep calling them unchanged).

- [ ] **Step 4: Implement `config-edit.ts`**

```ts
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseDocument, isMap, isSeq } from "yaml";
import type { Document } from "yaml";
import { deriveRepoName } from "../core/config.js";
import type { RepoConfig } from "../core/config.js";
import { CliError } from "./errors.js";

// All config rewrites go through the yaml Document API so comments, key
// order, tuned phases, pricing, and `jira discover` output survive untouched.
export function readYamlDocument(path: string): Document {
  return parseDocument(readFileSync(path, "utf8"));
}

export function writeYamlDocument(path: string, doc: Document): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, doc.toString(), { encoding: "utf8" });
  renameSync(tmp, path);
}

function stringAt(doc: Document, path: string[]): string | undefined {
  const value: unknown = doc.getIn(path);
  return typeof value === "string" ? value : undefined;
}

// Legacy → workspace: lift project.buildCommand/testCommand/modules and
// sourceControl.config.owner/repo into project.repos[0]. Same transform for
// `migrate` step 5 and `init --add-repo` on a legacy install.
export function liftLegacyToRepos(doc: Document, repoPath: string): RepoConfig {
  if (doc.hasIn(["project", "repos"])) {
    throw new CliError("redqueen.yaml is already in workspace mode (project.repos is set)");
  }
  const owner = stringAt(doc, ["sourceControl", "config", "owner"]) ?? "";
  const repo = stringAt(doc, ["sourceControl", "config", "repo"]) ?? "";
  const scType = stringAt(doc, ["sourceControl", "type"]) ?? "github";
  const name = scType === "mock" || repo === "" ? "default" : deriveRepoName(repo);
  const baseBranch = stringAt(doc, ["pipeline", "baseBranch"]) ?? "origin/main";
  const modulesNode: unknown = doc.getIn(["project", "modules"], true);
  const modules: unknown = isSeq(modulesNode) ? modulesNode.toJSON() : undefined;
  const entry: RepoConfig = {
    name,
    path: repoPath,
    owner,
    repo,
    baseBranch,
    buildCommand: stringAt(doc, ["project", "buildCommand"]) ?? "",
    testCommand: stringAt(doc, ["project", "testCommand"]) ?? "",
    modules: Array.isArray(modules) ? (modules as RepoConfig["modules"]) : [],
  };
  const yamlEntry: Record<string, unknown> = {
    name: entry.name,
    path: entry.path,
    owner: entry.owner,
    repo: entry.repo,
    buildCommand: entry.buildCommand,
    testCommand: entry.testCommand,
  };
  // The lifted repo inherits pipeline.baseBranch, so no per-repo override.
  if (isSeq(modulesNode)) {
    yamlEntry.modules = modulesNode;
  }
  doc.setIn(["project", "repos"], [yamlEntry]);
  doc.deleteIn(["project", "buildCommand"]);
  doc.deleteIn(["project", "testCommand"]);
  doc.deleteIn(["project", "modules"]);
  doc.deleteIn(["sourceControl", "config", "owner"]);
  doc.deleteIn(["sourceControl", "config", "repo"]);
  const scConfig: unknown = doc.getIn(["sourceControl", "config"], true);
  if (isMap(scConfig) && scConfig.items.length === 0) {
    doc.deleteIn(["sourceControl", "config"]);
  }
  return entry;
}

export function appendRepo(doc: Document, entry: RepoConfig): void {
  const reposNode: unknown = doc.getIn(["project", "repos"], true);
  if (isSeq(reposNode) === false) {
    throw new CliError(
      "redqueen.yaml has no project.repos — run `redqueen migrate` or `redqueen init` first",
    );
  }
  const existing = reposNode.toJSON() as { name?: unknown; path?: unknown }[];
  for (const r of existing) {
    if (r.name === entry.name) {
      throw new CliError(`redqueen.yaml already declares repo "${entry.name}"`);
    }
    if (r.path === entry.path) {
      throw new CliError(`redqueen.yaml already declares path "${entry.path}"`);
    }
  }
  const pipelineBase = stringAt(doc, ["pipeline", "baseBranch"]) ?? "origin/main";
  const yamlEntry: Record<string, unknown> = {
    name: entry.name,
    path: entry.path,
    owner: entry.owner,
    repo: entry.repo,
  };
  if (entry.baseBranch !== pipelineBase) {
    yamlEntry.baseBranch = entry.baseBranch;
  }
  yamlEntry.buildCommand = entry.buildCommand;
  yamlEntry.testCommand = entry.testCommand;
  if (entry.modules.length > 0) {
    yamlEntry.modules = entry.modules;
  }
  reposNode.add(doc.createNode(yamlEntry));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/cli/__tests__/repo-discovery.test.ts src/cli/__tests__/config-edit.test.ts src/cli/__tests__/init.test.ts`
Expected: PASS.

- [ ] **Step 6: Check + commit**

```bash
npm run check
git add src/cli/repo-discovery.ts src/cli/config-edit.ts src/cli/init.ts src/cli/__tests__
git commit -m "feat(cli): shared repo discovery and comment-preserving config edits for workspace tooling"
```

---

### Task 3: `redqueen init` in a workspace root and `--map-only` for sectioned maps

**Files:**

- Modify: `src/cli/init.ts`
- Modify: `src/cli/help.ts` (init help)
- Test: `src/cli/__tests__/init.test.ts`

**Interfaces:**

- `cmdInit` in a directory that is **not** a git work tree root but has git-repo children → workspace init. `--yes` includes every child; interactive prompts `Include <dir> (<owner/repo>)? [Y/n]` per child. Tracker/auth/webhook/dashboard prompts run once (existing functions). Writes `redqueen.yaml` with `project.repos[]` (no `buildCommand`/`testCommand`, no `sourceControl.config.owner/repo`), `.redqueen/` scaffolding, references, `.env`, and the sectioned map. `.gitignore` block only when the root itself is a git repo.
- `--map-only`: sectioned regeneration when `project.repos` is present in the YAML.

- [ ] **Step 1: Write the failing tests**

Append to `src/cli/__tests__/init.test.ts` (the file's `beforeEach` runs `git init` in `tmp`; these tests need a **non**-repo root, so create a nested workspace dir):

```ts
describe("cmdInit workspace mode", () => {
  function workspace(): string {
    const root = join(tmp, "ws");
    mkdirSync(root, { recursive: true });
    for (const [dir, remote, pkg] of [
      [
        "AlignSmart",
        "git@github.com:alignsmart/AlignSmart.git",
        '{"scripts":{"build":"x","test":"y"}}',
      ],
      ["EmailTemplates", "https://github.com/alignsmart/EmailTemplates.git", null],
    ] as const) {
      const path = join(root, dir);
      mkdirSync(path, { recursive: true });
      execSync("git init -q", { cwd: path });
      execSync(`git remote add origin ${remote}`, { cwd: path });
      if (pkg !== null) {
        writeFileSync(join(path, "package.json"), pkg);
      }
      writeFileSync(join(path, "README.md"), `# ${dir}\n\n${dir} does things.\n`);
    }
    mkdirSync(join(root, "not-a-repo"));
    process.chdir(root);
    return root;
  }

  it("scaffolds project.repos[] from git children with --yes", async () => {
    const root = workspace();
    await cmdInit(["--yes"]);

    process.env.GITHUB_PAT = "test-pat";
    try {
      const config = parseConfig(readFileSync(join(root, "redqueen.yaml"), "utf8"));
      expect(config.project.workspaceMode).toBe(true);
      expect(config.project.repos.map((r) => [r.name, r.path, r.owner, r.repo])).toEqual([
        ["alignsmart", "./AlignSmart", "alignsmart", "AlignSmart"],
        ["emailtemplates", "./EmailTemplates", "alignsmart", "EmailTemplates"],
      ]);
      expect(config.project.repos[0]?.buildCommand).toBe("npm run build");
      expect(config.sourceControl.config.owner).toBeUndefined();
      expect(config.issueTracker.config.owner).toBe("alignsmart");
    } finally {
      delete process.env.GITHUB_PAT;
    }
    const map = readFileSync(join(root, ".redqueen", "codebase-map.md"), "utf8");
    expect(map).toContain("## Repo: alignsmart");
    expect(map).toContain("## Repo: emailtemplates");
    expect(map).toContain("AlignSmart does things.");
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
    expect(existsSync(join(root, ".redqueen", "references", "coding-standards.md"))).toBe(true);
  });

  it("--map-only regenerates sectioned maps and preserves edits", async () => {
    const root = workspace();
    await cmdInit(["--yes"]);
    const mapPath = join(root, ".redqueen", "codebase-map.md");
    const edited = readFileSync(mapPath, "utf8").replace(
      "### Key Notes (edit me)\n- Describe the module structure here.",
      "### Key Notes (edit me)\n- Human note for alignsmart.",
    );
    writeFileSync(mapPath, edited);
    await cmdInit(["--map-only"]);
    const regenerated = readFileSync(mapPath, "utf8");
    expect(regenerated).toContain("- Human note for alignsmart.");
    expect(regenerated).toContain("## Repo: emailtemplates");
  });

  it("refuses a workspace root with no git children", async () => {
    const root = join(tmp, "empty");
    mkdirSync(root);
    process.chdir(root);
    await expect(cmdInit(["--yes"])).rejects.toThrow(
      /inside a git repository or in a folder that contains git repositories/,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/__tests__/init.test.ts -t "workspace mode"`
Expected: FAIL — `preflight` throws "must run inside a git repository".

- [ ] **Step 3: Implement**

In `src/cli/init.ts`:

(a) Replace `preflight` and the call site in `cmdInit`:

```ts
type InitMode = { kind: "single" } | { kind: "workspace"; children: DiscoveredRepo[] };

function detectMode(projectDir: string): InitMode {
  if (isGitWorkTreeRoot(projectDir)) {
    return { kind: "single" };
  }
  const children = discoverRepoChildren(projectDir);
  if (children.length === 0) {
    throw new CliError(
      "redqueen init must run inside a git repository or in a folder that contains git repositories (a workspace root). Run `git init` first, or cd to the parent of your repos.",
    );
  }
  return { kind: "workspace", children };
}
```

and in `cmdInit` replace `preflight(projectDir);` + the `answers`/`writeAllFiles` lines with:

```ts
const mode = detectMode(projectDir);
process.stdout.write("Red Queen — project setup\n\n");

if (mode.kind === "workspace") {
  const answers =
    values.yes === true
      ? await workspaceAnswersWithDefaults(projectDir, mode.children)
      : await workspaceInteractivePrompt(projectDir, mode.children);
  await writeWorkspaceFiles(projectDir, answers);
  printWorkspaceNextSteps(answers);
  return;
}

const answers =
  values.yes === true ? await answerWithDefaults(projectDir) : await interactivePrompt(projectDir);
await writeAllFiles(projectDir, answers);
```

(keep the existing "Setup complete" output after `writeAllFiles`).

(b) Add the workspace types and flows:

```ts
interface WorkspaceRepoAnswer {
  entry: RepoConfig;
  languages: LanguageDetection[];
  primary: LanguageKey;
}

interface WorkspaceInitAnswers {
  repos: WorkspaceRepoAnswer[];
  issueTrackerType: "jira" | "github-issues";
  issueTrackerConfig: Record<string, unknown>;
  sourceControlConfig: Record<string, unknown>; // auth (+ webhookSecret) only
  githubAuthKind: GitHubAuthKind;
  webhooksEnabled: boolean;
  webhookPublicBaseUrl: string | null;
  webhookIssueTrackerPath: string | null;
  webhookSourceControlPath: string | null;
  dashboardPort: number;
  codingStandardsTemplate: string;
  reviewChecklistTemplate: string;
}

function deriveWorkspaceRepos(rootDir: string, children: DiscoveredRepo[]): WorkspaceRepoAnswer[] {
  return children.map((child) => {
    const derived = deriveRepoEntry(child.path, rootDir);
    return { entry: derived.entry, languages: derived.languages, primary: derived.primary };
  });
}

async function workspaceAnswersWithDefaults(
  rootDir: string,
  children: DiscoveredRepo[],
): Promise<WorkspaceInitAnswers> {
  const repos = deriveWorkspaceRepos(rootDir, children);
  const first = repos[0];
  if (first === undefined) {
    throw new CliError("no repos discovered");
  }
  process.stdout.write(`Discovered ${String(repos.length)} repos:\n`);
  for (const r of repos) {
    process.stdout.write(
      `  - ${r.entry.name}  ${r.entry.path}  (${r.entry.owner}/${r.entry.repo})\n`,
    );
  }
  const patAuth = buildGitHubAuthBlock("pat");
  return Promise.resolve({
    repos,
    issueTrackerType: "github-issues",
    issueTrackerConfig: { owner: first.entry.owner, repo: first.entry.repo, auth: patAuth },
    sourceControlConfig: { auth: patAuth },
    githubAuthKind: "pat",
    webhooksEnabled: false,
    webhookPublicBaseUrl: null,
    webhookIssueTrackerPath: null,
    webhookSourceControlPath: null,
    dashboardPort: 4400,
    codingStandardsTemplate: first.primary === "blank" ? "blank" : first.primary,
    reviewChecklistTemplate: "web-api",
  });
}

async function workspaceInteractivePrompt(
  rootDir: string,
  children: DiscoveredRepo[],
): Promise<WorkspaceInitAnswers> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`Workspace root: ${rootDir}\nDiscovered git repositories:\n`);
    const chosen: DiscoveredRepo[] = [];
    for (const child of children) {
      const label = child.remote === null ? "(no origin remote — will be skipped)" : child.remote;
      const resp = (await rl.question(`  Include ${child.dirName} ${label}? [Y/n]: `))
        .trim()
        .toLowerCase();
      if (resp === "" || resp === "y") {
        chosen.push(child);
      }
    }
    if (chosen.length === 0) {
      throw new CliError("No repos selected.");
    }
    const repos = deriveWorkspaceRepos(rootDir, chosen);
    for (const r of repos) {
      r.entry.buildCommand = await promptCommand(
        rl,
        `${r.entry.name}: build command`,
        r.entry.buildCommand,
      );
      r.entry.testCommand = await promptCommand(
        rl,
        `${r.entry.name}: test command`,
        r.entry.testCommand,
      );
    }
    const first = repos[0];
    if (first === undefined) {
      throw new CliError("no repos discovered");
    }
    const githubAuthKind = await pickGitHubAuthKind(rl);
    const githubAuthBlock = buildGitHubAuthBlock(githubAuthKind);
    const webhookAnswers = await pickWebhooks(rl);
    const { issueTrackerType, issueTrackerConfig } = await pickIssueTracker(
      rl,
      join(rootDir, first.entry.path),
      githubAuthBlock,
      webhookAnswers.webhooksEnabled,
    );
    const sourceControlConfig: Record<string, unknown> = { auth: githubAuthBlock };
    if (webhookAnswers.webhooksEnabled) {
      sourceControlConfig.webhookSecret = "${GITHUB_WEBHOOK_SECRET}";
    }
    const dashboardPort = await pickDashboardPort(rl);
    const codingStandardsTemplate = await pickTemplate(
      rl,
      "coding-standards",
      "Coding standards template",
      first.primary === "blank" ? "blank" : first.primary,
    );
    const reviewChecklistTemplate = await pickTemplate(
      rl,
      "review-checklist",
      "Review checklist template",
      "web-api",
    );
    return {
      repos,
      issueTrackerType,
      issueTrackerConfig,
      sourceControlConfig,
      githubAuthKind,
      webhooksEnabled: webhookAnswers.webhooksEnabled,
      webhookPublicBaseUrl: webhookAnswers.publicBaseUrl,
      webhookIssueTrackerPath: webhookAnswers.issueTrackerPath,
      webhookSourceControlPath: webhookAnswers.sourceControlPath,
      dashboardPort,
      codingStandardsTemplate,
      reviewChecklistTemplate,
    };
  } finally {
    rl.close();
  }
}

async function writeWorkspaceFiles(rootDir: string, answers: WorkspaceInitAnswers): Promise<void> {
  const redqueenDir = join(rootDir, ".redqueen");
  const referencesDir = join(redqueenDir, "references");
  const skillsDir = join(redqueenDir, "skills");
  mkdirSync(referencesDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(redqueenDir, ".gitkeep"), "");
  writeFileSync(join(skillsDir, ".gitkeep"), "");

  writeWorkspaceConfigFile(join(rootDir, "redqueen.yaml"), answers);

  writeFileSync(
    join(redqueenDir, "codebase-map.md"),
    generateWorkspaceMap({
      rootDir,
      generatedAt: new Date().toISOString().slice(0, 10),
      repos: answers.repos.map((r) => ({
        name: r.entry.name,
        path: join(rootDir, r.entry.path),
        languages: r.languages,
        primary: r.primary,
        buildCommand: r.entry.buildCommand,
        testCommand: r.entry.testCommand,
      })),
    }),
  );

  copyTemplate(
    "coding-standards",
    answers.codingStandardsTemplate,
    join(referencesDir, "coding-standards.md"),
  );
  copyTemplate(
    "review-checklist",
    answers.reviewChecklistTemplate,
    join(referencesDir, "review-checklist.md"),
  );
  copyTemplate("spec-template", "generic", join(referencesDir, "spec-template.md"));

  // The root gets a .gitignore block only when it is itself a repo.
  if (isGitWorkTreeRoot(rootDir)) {
    updateGitignore(rootDir);
  }
  writeDotEnvScaffold(rootDir, {
    githubAuthKind: answers.githubAuthKind,
    issueTrackerType: answers.issueTrackerType,
    webhooksEnabled: answers.webhooksEnabled,
  });
  return Promise.resolve();
}

function writeWorkspaceConfigFile(path: string, answers: WorkspaceInitAnswers): void {
  const pipeline: Record<string, unknown> = {
    baseBranch: answers.repos[0]?.entry.baseBranch ?? "origin/main",
  };
  if (answers.webhooksEnabled) {
    const webhooks: Record<string, unknown> = { enabled: true };
    if (answers.webhookPublicBaseUrl !== null) {
      webhooks.publicBaseUrl = answers.webhookPublicBaseUrl;
    }
    const paths: Record<string, string> = {};
    if (answers.webhookIssueTrackerPath !== null) {
      paths.issueTracker = answers.webhookIssueTrackerPath;
    }
    if (answers.webhookSourceControlPath !== null) {
      paths.sourceControl = answers.webhookSourceControlPath;
    }
    if (Object.keys(paths).length > 0) {
      webhooks.paths = paths;
    }
    pipeline.webhooks = webhooks;
  }
  const pipelineBase = pipeline.baseBranch;
  const config: Record<string, unknown> = {
    issueTracker: { type: answers.issueTrackerType, config: answers.issueTrackerConfig },
    sourceControl: { type: "github", config: answers.sourceControlConfig },
    pipeline,
    project: {
      repos: answers.repos.map((r) => ({
        name: r.entry.name,
        path: r.entry.path,
        owner: r.entry.owner,
        repo: r.entry.repo,
        ...(r.entry.baseBranch === pipelineBase ? {} : { baseBranch: r.entry.baseBranch }),
        buildCommand: r.entry.buildCommand,
        testCommand: r.entry.testCommand,
      })),
    },
    dashboard: { port: answers.dashboardPort },
  };
  const yaml = stringifyYaml(config, { lineWidth: 0 });
  const commentedModules = [
    "",
    "# Optional: per-module commands inside one repo (paths are repo-relative).",
    "# project:",
    "#   repos:",
    "#     - name: <repo>",
    "#       modules:",
    "#         - name: web",
    '#           paths: ["src/web/**"]',
    "#           buildCommand: npm run build --workspace=web",
    "#           testCommandTargeted: npm test --workspace=web",
    "",
  ].join("\n");
  writeAtomic(path, `${yaml}${commentedModules}`);
}

function printWorkspaceNextSteps(answers: WorkspaceInitAnswers): void {
  process.stdout.write("\nSetup complete (workspace mode).\n");
  process.stdout.write("  - redqueen.yaml               (project.repos[] — one entry per repo)\n");
  process.stdout.write("  - .env                        (fill in your tokens — gitignored)\n");
  process.stdout.write("  - .redqueen/codebase-map.md   (edit each repo's '(edit me)' blocks)\n");
  process.stdout.write(
    "  - .redqueen/references/       (coding standards + checklist + spec template)\n",
  );
  process.stdout.write("\nNext: fill in .env, then run `npx redqueen start`.\n");
  if (answers.webhooksEnabled) {
    process.stdout.write(
      "Next: add a source-control webhook on every repo (or one org-level webhook) pointing at the same URL with the same secret.\n",
    );
  }
  if (answers.issueTrackerType === "jira") {
    process.stdout.write(
      "Next: run `redqueen jira discover` to auto-fill customFields and phaseMapping.\n",
    );
  }
  process.stdout.write("Tip: `redqueen init --add-repo <path>` appends another repo later.\n");
}
```

`writeDotEnvScaffold` currently takes `InitAnswers`; narrow its parameter type to `Pick<InitAnswers, "githubAuthKind" | "issueTrackerType" | "webhooksEnabled">` so both flows can call it. Add imports: `deriveRepoEntry`, `discoverRepoChildren`, `isGitWorkTreeRoot`, `DiscoveredRepo` from `./repo-discovery.js`; `generateWorkspaceMap`, `isWorkspaceMap` from `./codebase-map.js`; `RepoConfig` from `../core/config.js`.

(c) `regenerateMapOnly`: branch on the YAML shape.

```ts
async function regenerateMapOnly(projectDir: string): Promise<void> {
  const configPath = join(projectDir, "redqueen.yaml");
  if (existsSync(configPath) === false) {
    throw new CliError("Cannot run --map-only without a redqueen.yaml in the current directory.");
  }
  const mapPath = resolve(projectDir, ".redqueen", "codebase-map.md");
  if (existsSync(mapPath) === false) {
    throw new CliError(".redqueen/codebase-map.md does not exist — run `redqueen init` first.");
  }
  const config = loadConfig(configPath);
  const generatedAt = new Date().toISOString().slice(0, 10);
  const regenerated = config.project.workspaceMode
    ? generateWorkspaceMap({
        rootDir: projectDir,
        generatedAt,
        repos: config.project.repos.map((repo) => {
          const languages = detectLanguages(repo.path);
          return {
            name: repo.name,
            path: repo.path,
            languages,
            primary: languages[0]?.key ?? "blank",
            buildCommand: repo.buildCommand,
            testCommand: repo.testCommand,
          };
        }),
      })
    : generateCodebaseMap({
        projectDir,
        languages: detectLanguages(projectDir),
        primary: detectLanguages(projectDir)[0]?.key ?? "blank",
        buildCommand: config.project.buildCommand ?? "",
        testCommand: config.project.testCommand ?? "",
        generatedAt,
      });
  const existing = readFileSync(mapPath, "utf8");
  writeFileSync(mapPath, mergeRegeneratedMap(existing, regenerated));
  process.stdout.write("Regenerated .redqueen/codebase-map.md (edit-me sections preserved).\n");
  return Promise.resolve();
}
```

(`loadConfig` from `../core/config.js` — it validates repo paths and absolutizes them, which the map generator needs. Delete the now-unused `readProjectCommands` and the `parseYaml` import if nothing else uses them. `loadConfig` interpolates `${VAR}` references, so `--map-only` now needs the env vars set or a `.env`; call `loadDotEnv(projectDir)` from `../core/env.js` first.)

`src/cli/help.ts` init help: add `  --add-repo <path>  Append a repo to an existing workspace (or convert a single-repo install in place)` and a line under `init` in the top-level text: `init                        Scaffold a project — in a git repo (single-repo) or in a folder of git repos (workspace)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/__tests__/init.test.ts`
Expected: PASS (legacy init tests unchanged).

- [ ] **Step 5: Check + commit**

```bash
npm run check
git add src/cli/init.ts src/cli/help.ts src/cli/__tests__/init.test.ts
git commit -m "feat(init): scaffold a workspace from a folder of git repos"
```

---

### Task 4: `redqueen init --add-repo <path>`

**Files:**

- Modify: `src/cli/init.ts`
- Test: `src/cli/__tests__/init.test.ts`

**Interfaces:**

- `cmdInit(["--add-repo", "<path>"])` on a directory with `redqueen.yaml`: derive the entry, lift a legacy config in place first (`liftLegacyToRepos(doc, "./<basename of project.directory or '.'>")` — the in-place conversion keeps the single repo at `path: .`), `appendRepo`, write the YAML, then add the repo's section to the map (or convert a flat map to sectioned with the existing repo's Key Notes carried into its section).

- [ ] **Step 1: Write the failing tests**

Append to `src/cli/__tests__/init.test.ts`:

```ts
describe("cmdInit --add-repo", () => {
  it("appends a repo to a workspace config and map", async () => {
    const root = join(tmp, "ws2");
    mkdirSync(root, { recursive: true });
    const mk = (dir: string, remote: string): string => {
      const p = join(root, dir);
      mkdirSync(p, { recursive: true });
      execSync("git init -q", { cwd: p });
      execSync(`git remote add origin ${remote}`, { cwd: p });
      return p;
    };
    mk("Api", "git@github.com:acme/Api.git");
    process.chdir(root);
    await cmdInit(["--yes"]);
    const webPath = mk("Web", "git@github.com:acme/Web.git");

    await cmdInit(["--add-repo", webPath]);

    process.env.GITHUB_PAT = "x";
    try {
      const config = parseConfig(readFileSync(join(root, "redqueen.yaml"), "utf8"));
      expect(config.project.repos.map((r) => r.name)).toEqual(["api", "web"]);
      expect(config.project.repos[1]?.path).toBe("./Web");
    } finally {
      delete process.env.GITHUB_PAT;
    }
    expect(readFileSync(join(root, ".redqueen", "codebase-map.md"), "utf8")).toContain(
      "## Repo: web",
    );
    await expect(cmdInit(["--add-repo", webPath])).rejects.toThrow(/already declares/);
  });

  it("lifts a legacy install in place before appending", async () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    execSync("git remote add origin git@github.com:acme/Legacy.git", { cwd: tmp });
    await cmdInit(["--yes"]); // legacy single-repo init in tmp (a git repo)
    const mapBefore = readFileSync(join(tmp, ".redqueen", "codebase-map.md"), "utf8");
    writeFileSync(
      join(tmp, ".redqueen", "codebase-map.md"),
      mapBefore.replace("- Describe the module structure here.", "- Legacy note."),
    );
    const sibling = join(tmp, "..", `rq-sibling-${String(process.pid)}`);
    mkdirSync(sibling, { recursive: true });
    execSync("git init -q", { cwd: sibling });
    execSync("git remote add origin git@github.com:acme/Sibling.git", { cwd: sibling });
    try {
      await cmdInit(["--add-repo", sibling]);
      process.env.GITHUB_PAT = "x";
      const yaml = readFileSync(join(tmp, "redqueen.yaml"), "utf8");
      const config = parseConfig(yaml);
      expect(config.project.workspaceMode).toBe(true);
      expect(config.project.repos.map((r) => [r.name, r.path])).toEqual([
        ["legacy", "."],
        ["sibling", `../${basename(sibling)}`],
      ]);
      expect(yaml).toContain("# Optional: per-module commands"); // comment survived
      const map = readFileSync(join(tmp, ".redqueen", "codebase-map.md"), "utf8");
      expect(map).toContain("## Repo: legacy");
      expect(map).toContain("- Legacy note.");
      expect(map).toContain("## Repo: sibling");
    } finally {
      delete process.env.GITHUB_PAT;
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});
```

(`basename` from `node:path`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/__tests__/init.test.ts -t "add-repo"`
Expected: FAIL — unknown option.

- [ ] **Step 3: Implement**

In `cmdInit`'s `parseArgs` options add `"add-repo": { type: "string" }`, and before the `--map-only` branch:

```ts
if (values["add-repo"] !== undefined) {
  await addRepo(projectDir, resolve(projectDir, values["add-repo"]));
  return;
}
```

Add:

```ts
async function addRepo(rootDir: string, repoPath: string): Promise<void> {
  const configPath = join(rootDir, "redqueen.yaml");
  if (existsSync(configPath) === false) {
    throw new CliError("--add-repo needs an existing redqueen.yaml in the current directory.");
  }
  const derived = deriveRepoEntry(repoPath, rootDir);
  const doc = readYamlDocument(configPath);
  let lifted: RepoConfig | null = null;
  if (doc.hasIn(["project", "repos"]) === false) {
    // Legacy install: the in-place "convert without moving" path. The existing
    // repo stays at project.directory (default ".").
    const directory: unknown = doc.getIn(["project", "directory"]);
    lifted = liftLegacyToRepos(doc, typeof directory === "string" ? directory : ".");
  }
  appendRepo(doc, derived.entry);
  writeYamlDocument(configPath, doc);

  const mapPath = join(rootDir, ".redqueen", "codebase-map.md");
  const generatedAt = new Date().toISOString().slice(0, 10);
  const newSection = renderRepoSection({
    name: derived.entry.name,
    path: repoPath,
    languages: derived.languages,
    primary: derived.primary,
    buildCommand: derived.entry.buildCommand,
    testCommand: derived.entry.testCommand,
  });
  if (existsSync(mapPath)) {
    const existing = readFileSync(mapPath, "utf8");
    if (isWorkspaceMap(existing)) {
      writeFileSync(
        mapPath,
        `${existing.endsWith("\n") ? existing : `${existing}\n`}${newSection}`,
      );
    } else if (lifted !== null) {
      // Flat map → sectioned: the old repo becomes the first section and keeps
      // its Key Notes; the new repo gets a fresh section.
      const liftedPath = resolve(rootDir, lifted.path);
      const liftedLanguages = detectLanguages(liftedPath);
      const liftedSection = renderRepoSection({
        name: lifted.name,
        path: liftedPath,
        languages: liftedLanguages,
        primary: liftedLanguages[0]?.key ?? "blank",
        buildCommand: lifted.buildCommand,
        testCommand: lifted.testCommand,
      });
      const keyNotesIdx = existing.indexOf(KEY_NOTES_FLAT_HEADER);
      const keptNotes =
        keyNotesIdx === -1 ? null : existing.slice(keyNotesIdx + KEY_NOTES_FLAT_HEADER.length);
      const liftedWithNotes =
        keptNotes === null
          ? liftedSection
          : liftedSection.replace(
              /### Key Notes \(edit me\)\n[\s\S]*$/,
              `### Key Notes (edit me)${keptNotes}`,
            );
      const head = generateWorkspaceMap({ rootDir, generatedAt, repos: [] });
      writeFileSync(mapPath, `${head}${liftedWithNotes}${newSection}`);
    }
  }

  process.stdout.write(
    `Added repo ${derived.entry.name} (${derived.entry.path}) to redqueen.yaml${lifted === null ? "" : ` and converted the install to workspace mode (${lifted.name} at ${lifted.path})`}.\n`,
  );
  if (
    doc.hasIn(["pipeline", "webhooks", "enabled"]) &&
    doc.getIn(["pipeline", "webhooks", "enabled"]) === true
  ) {
    process.stdout.write(
      "Add a source-control webhook on the new repo pointing at the same URL with the same secret.\n",
    );
  }
  process.stdout.write("Restart the orchestrator to pick up the new repo.\n");
  return Promise.resolve();
}
```

Export `KEY_NOTES_HEADER` from `codebase-map.ts` as `KEY_NOTES_FLAT_HEADER` (`export const KEY_NOTES_FLAT_HEADER = KEY_NOTES_HEADER;`) and import it plus `renderRepoSection`, `isWorkspaceMap` in `init.ts`; import `readYamlDocument`, `writeYamlDocument`, `liftLegacyToRepos`, `appendRepo` from `./config-edit.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/__tests__/init.test.ts`
Expected: PASS.

- [ ] **Step 5: Check + commit**

```bash
npm run check
git add src/cli/init.ts src/cli/codebase-map.ts src/cli/__tests__/init.test.ts
git commit -m "feat(init): --add-repo appends a sibling and converts legacy installs in place"
```

---

### Task 5: `redqueen migrate`

**Files:**

- Create: `src/cli/migrate.ts`
- Modify: `src/cli/index.ts` (register `migrate`), `src/cli/help.ts`
- Test: `src/cli/__tests__/migrate.test.ts`

**Interfaces:**

- `cmdMigrate(args)`: flags `--dry-run`, `--yes`. Exported for tests: `planMigration(cwd): MigrationPlan` (pure checks + plan), `executeMigration(plan, io): void`.
  ```ts
  export interface MigrationPlan {
    installDir: string;
    parentDir: string;
    dirName: string;
    repoName: string;
    worktreeMoves: { from: string; to: string }[]; // registered under .redqueen/worktrees
    staleRefreshWorktrees: string[]; // refresh-* → removed, not moved
    fileMoves: { from: string; to: string }[]; // remaining .redqueen/* entries, redqueen.yaml, .env
    serviceInstalled: boolean;
  }
  ```
- Steps 3–7 follow the spec exactly; on a failure after worktree moves begin, the error message lists the completed moves and the reverse `git worktree move <to> <from>` commands.

- [ ] **Step 1: Write the failing test**

`src/cli/__tests__/migrate.test.ts` — a real git repo with a registered worktree, a tuned config with comments, a DB with a legacy record:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { RedQueenDatabase } from "../../core/database.js";
import { PipelineStateStore } from "../../core/pipeline-state.js";
import { parseConfig } from "../../core/config.js";
import { cmdMigrate } from "../migrate.js";

let parent: string;
let install: string;
let originalCwd: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "rq-migrate-"));
  install = join(parent, "My_App");
  mkdirSync(install);
  execSync("git init -q -b main", { cwd: install });
  execSync("git config user.email t@e.com && git config user.name T", { cwd: install });
  writeFileSync(join(install, "README.md"), "# app\n");
  execSync("git add . && git commit -qm init", { cwd: install });
  execSync("git remote add origin git@github.com:acme/My_App.git", { cwd: install });
  writeFileSync(
    join(install, "redqueen.yaml"),
    [
      "# tuned by hand",
      "issueTracker:",
      "  type: mock",
      "sourceControl:",
      "  type: github",
      "  config:",
      "    owner: acme",
      "    repo: My_App",
      "    auth: { type: pat, token: tok }",
      "project:",
      "  buildCommand: npm run build",
      "  testCommand: npm test",
      "pipeline:",
      "  baseBranch: origin/main",
      "  cost:",
      "    enabled: true # keep",
      "service:",
      "  workingDirectory: .",
      "",
    ].join("\n"),
  );
  writeFileSync(join(install, ".env"), "GITHUB_PAT=x\n");
  mkdirSync(join(install, ".redqueen", "worktrees"), { recursive: true });
  execSync(
    `git worktree add -q -b feature/PROJ-1 ${join(install, ".redqueen", "worktrees", "PROJ-1")} main`,
    { cwd: install },
  );
  execSync(
    `git worktree add -q --detach ${join(install, ".redqueen", "worktrees", "spec-PROJ-2")} main`,
    { cwd: install },
  );
  execSync(
    `git worktree add -q --detach ${join(install, ".redqueen", "worktrees", "refresh-PROJ-3")} main`,
    { cwd: install },
  );
  const db = new RedQueenDatabase(join(install, ".redqueen", "redqueen.db"));
  const store = new PipelineStateStore(db.db, ["my-app"]);
  store.create("PROJ-1", "coding");
  db.db
    .prepare("UPDATE pipeline_state SET branch_name = ?, worktree_path = ? WHERE issue_id = ?")
    .run("feature/PROJ-1", join(install, ".redqueen", "worktrees", "PROJ-1"), "PROJ-1");
  db.close();
  originalCwd = process.cwd();
  process.chdir(install);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(parent, { recursive: true, force: true });
});

describe("cmdMigrate", () => {
  it("--dry-run touches nothing", async () => {
    await cmdMigrate(["--dry-run"]);
    expect(existsSync(join(parent, "redqueen.yaml"))).toBe(false);
    expect(existsSync(join(install, "redqueen.yaml"))).toBe(true);
  });

  it("moves the install up one directory and keeps worktrees registered", async () => {
    await cmdMigrate(["--yes"]);

    expect(existsSync(join(install, "redqueen.yaml"))).toBe(false);
    expect(existsSync(join(install, ".redqueen"))).toBe(false);
    expect(existsSync(join(parent, ".env"))).toBe(true);
    const yaml = readFileSync(join(parent, "redqueen.yaml"), "utf8");
    expect(yaml).toContain("# tuned by hand");
    expect(yaml).toContain("enabled: true # keep");
    process.env.GITHUB_PAT = "x";
    try {
      const config = parseConfig(yaml);
      expect(config.project.workspaceMode).toBe(true);
      expect(config.project.repos).toEqual([
        expect.objectContaining({
          name: "my-app",
          path: "./My_App",
          owner: "acme",
          repo: "My_App",
          baseBranch: "origin/main",
        }),
      ]);
      expect(config.service.workingDirectory).toBe(".");
    } finally {
      delete process.env.GITHUB_PAT;
    }

    const coding = join(parent, ".redqueen", "worktrees", "PROJ-1", "my-app");
    const spec = join(parent, ".redqueen", "worktrees", "spec-PROJ-2", "my-app");
    expect(existsSync(coding)).toBe(true);
    expect(existsSync(spec)).toBe(true);
    expect(existsSync(join(parent, ".redqueen", "worktrees", "refresh-PROJ-3"))).toBe(false);
    const registered = execSync("git worktree list --porcelain", {
      cwd: install,
      encoding: "utf8",
    });
    expect(registered).toContain(`worktree ${coding}`);
    expect(registered).toContain(`worktree ${spec}`);
    expect(registered).not.toContain("refresh-PROJ-3");

    const db = new Database(join(parent, ".redqueen", "redqueen.db"), { readonly: true });
    const state = db
      .prepare("SELECT worktree_path FROM pipeline_state WHERE issue_id = 'PROJ-1'")
      .get() as { worktree_path: string };
    expect(state.worktree_path).toBe(coding);
    const row = db
      .prepare("SELECT repo, worktree_path, in_scope FROM pipeline_repos WHERE issue_id = 'PROJ-1'")
      .get() as { repo: string; worktree_path: string; in_scope: number };
    expect(row).toEqual({ repo: "my-app", worktree_path: coding, in_scope: 1 });
    db.close();
  });

  it("fails fast on preconditions before touching anything", async () => {
    writeFileSync(join(parent, "redqueen.yaml"), "x");
    await expect(cmdMigrate(["--yes"])).rejects.toThrow(/already exists/);
    expect(existsSync(join(install, "redqueen.yaml"))).toBe(true);
    rmSync(join(parent, "redqueen.yaml"));
    writeFileSync(join(install, ".redqueen", "redqueen.pid"), String(process.pid));
    await expect(cmdMigrate(["--yes"])).rejects.toThrow(/orchestrator is running/);
  });
});
```

(`basename` unused — drop it if lint complains.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/__tests__/migrate.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `migrate.ts`**

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { loadConfig } from "../core/config.js";
import { RedQueenDatabase } from "../core/database.js";
import { loadDotEnv } from "../core/env.js";
import { PipelineStateStore } from "../core/pipeline-state.js";
import {
  buildInstallContext,
  createServiceManager,
  resolveServicePaths,
  UnsupportedPlatformError,
  writeWrapperScript,
} from "../core/service/index.js";
import { liftLegacyToRepos, readYamlDocument, writeYamlDocument } from "./config-edit.js";
import { CliError } from "./errors.js";
import { isProcessAlive, readPidFile, resolvePidPath } from "./pid.js";
import { isGitWorkTreeRoot } from "./repo-discovery.js";
import { resolveRedqueenBinPath } from "./service.js";

export interface MigrationPlan {
  installDir: string;
  parentDir: string;
  dirName: string;
  repoName: string;
  worktreeMoves: { from: string; to: string }[];
  staleRefreshWorktrees: string[];
  fileMoves: { from: string; to: string }[];
  serviceInstalled: boolean;
}

const MIN_GIT = [2, 17] as const;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitVersionOk(cwd: string): boolean {
  const out = git(["--version"], cwd);
  const match = /(\d+)\.(\d+)/.exec(out);
  if (match?.[1] === undefined || match[2] === undefined) {
    return false;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]);
}

// Registered worktree paths from `git worktree list --porcelain` (the main
// work tree excluded).
function registeredWorktrees(repoDir: string): string[] {
  const out = git(["worktree", "list", "--porcelain"], repoDir);
  const paths = out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
  return paths.filter((p) => resolve(p) !== resolve(repoDir));
}

export function planMigration(cwd: string): MigrationPlan {
  const installDir = resolve(cwd);
  const configPath = join(installDir, "redqueen.yaml");
  if (existsSync(configPath) === false) {
    throw new CliError(
      "redqueen migrate must run inside the install directory (no redqueen.yaml here)",
    );
  }
  if (isGitWorkTreeRoot(installDir) === false) {
    throw new CliError(`${installDir} is not a git work tree root`);
  }
  loadDotEnv(installDir);
  const config = loadConfig(configPath);
  if (config.project.workspaceMode) {
    throw new CliError("redqueen.yaml is already in workspace mode — nothing to migrate");
  }
  if (resolve(installDir, config.project.directory) !== installDir) {
    throw new CliError(
      `project.directory (${config.project.directory}) must resolve to the install directory for migrate; run it from ${resolve(installDir, config.project.directory)} or set directory: .`,
    );
  }
  const pid = readPidFile(resolvePidPath(installDir));
  if (pid !== null && isProcessAlive(pid)) {
    throw new CliError(
      `orchestrator is running (pid ${String(pid)}) — stop it first (redqueen stop / redqueen service stop)`,
    );
  }
  const parentDir = dirname(installDir);
  if (parentDir === installDir) {
    throw new CliError("install directory has no parent");
  }
  for (const name of ["redqueen.yaml", ".redqueen"]) {
    if (existsSync(join(parentDir, name))) {
      throw new CliError(`${join(parentDir, name)} already exists — refusing to overwrite`);
    }
  }
  if (gitVersionOk(installDir) === false) {
    throw new CliError("git >= 2.17 is required (for `git worktree move`)");
  }

  const dirName = basename(installDir);
  const repo = config.project.repos[0];
  if (repo === undefined) {
    throw new CliError("no repo to migrate");
  }
  const worktreesDir = join(installDir, ".redqueen", "worktrees");
  const worktreeMoves: MigrationPlan["worktreeMoves"] = [];
  const staleRefreshWorktrees: string[] = [];
  for (const path of registeredWorktrees(installDir)) {
    if (path.startsWith(`${worktreesDir}/`) === false) {
      continue;
    }
    const id = basename(path);
    if (id.startsWith("refresh-")) {
      staleRefreshWorktrees.push(path);
      continue;
    }
    worktreeMoves.push({
      from: path,
      to: join(parentDir, ".redqueen", "worktrees", id, repo.name),
    });
  }
  const fileMoves: MigrationPlan["fileMoves"] = [];
  if (existsSync(join(installDir, ".redqueen"))) {
    for (const entry of readdirSync(join(installDir, ".redqueen")).sort()) {
      if (entry === "worktrees") {
        continue;
      }
      fileMoves.push({
        from: join(installDir, ".redqueen", entry),
        to: join(parentDir, ".redqueen", entry),
      });
    }
  }
  fileMoves.push({ from: configPath, to: join(parentDir, "redqueen.yaml") });
  if (existsSync(join(installDir, ".env"))) {
    fileMoves.push({ from: join(installDir, ".env"), to: join(parentDir, ".env") });
  }
  // ServiceManager.status is async; cmdMigrate fills this in after planning.
  return {
    installDir,
    parentDir,
    dirName,
    repoName: repo.name,
    worktreeMoves,
    staleRefreshWorktrees,
    fileMoves,
    serviceInstalled: false,
  };
}

function printPlan(plan: MigrationPlan): void {
  process.stdout.write(
    `Migrate ${plan.installDir} → ${plan.parentDir} (workspace mode, repo "${plan.repoName}" at ./${plan.dirName})\n\n`,
  );
  process.stdout.write("Worktrees to move:\n");
  for (const m of plan.worktreeMoves) {
    process.stdout.write(`  ${m.from}\n    → ${m.to}\n`);
  }
  if (plan.worktreeMoves.length === 0) {
    process.stdout.write("  (none)\n");
  }
  if (plan.staleRefreshWorktrees.length > 0) {
    process.stdout.write("Stale refresh worktrees to remove:\n");
    for (const p of plan.staleRefreshWorktrees) {
      process.stdout.write(`  ${p}\n`);
    }
  }
  process.stdout.write("Files to move:\n");
  for (const m of plan.fileMoves) {
    process.stdout.write(`  ${m.from} → ${m.to}\n`);
  }
  process.stdout.write(`Config: lift project/sourceControl fields into project.repos[0]\n`);
  process.stdout.write(
    `Database: rewrite worktree paths, adopt legacy rows into "${plan.repoName}"\n`,
  );
  if (plan.serviceInstalled) {
    process.stdout.write("Service: reinstall the unit with the new working directory\n");
  }
  process.stdout.write("\n");
}

// Steps 3–7. Nothing before step 3 has side effects; from step 3 on, every
// completed worktree move is recorded so a failure can print the exact reverse.
export function executeMigration(plan: MigrationPlan): void {
  const moved: { from: string; to: string }[] = [];
  const fail = (step: string, err: unknown): never => {
    const reverse = moved
      .map((m) => `  git -C ${plan.installDir} worktree move ${m.to} ${m.from}`)
      .join("\n");
    throw new CliError(
      `migrate failed during ${step}: ${err instanceof Error ? err.message : String(err)}\n` +
        (moved.length > 0
          ? `Worktrees already moved (${String(moved.length)}). To reverse:\n${reverse}\n`
          : "No worktrees were moved.\n"),
    );
  };

  // 3. Worktrees.
  try {
    mkdirSync(join(plan.parentDir, ".redqueen", "worktrees"), { recursive: true });
    for (const stale of plan.staleRefreshWorktrees) {
      git(["worktree", "remove", "--force", "--", stale], plan.installDir);
    }
    for (const m of plan.worktreeMoves) {
      mkdirSync(dirname(m.to), { recursive: true });
      git(["worktree", "move", m.from, m.to], plan.installDir);
      moved.push(m);
    }
    if (existsSync(join(plan.installDir, ".redqueen", "worktrees"))) {
      rmSync(join(plan.installDir, ".redqueen", "worktrees"), { recursive: true, force: true });
    }
  } catch (err) {
    fail("worktree move", err);
  }

  // 4. Remaining files.
  try {
    for (const m of plan.fileMoves) {
      mkdirSync(dirname(m.to), { recursive: true });
      renameSync(m.from, m.to);
    }
    if (existsSync(join(plan.installDir, ".redqueen"))) {
      rmSync(join(plan.installDir, ".redqueen"), { recursive: true, force: true });
    }
  } catch (err) {
    fail("file move", err);
  }

  // 5. Config rewrite (Document API keeps comments and tuned keys).
  const newConfigPath = join(plan.parentDir, "redqueen.yaml");
  try {
    const doc = readYamlDocument(newConfigPath);
    liftLegacyToRepos(doc, `./${plan.dirName}`);
    const wd: unknown = doc.getIn(["service", "workingDirectory"]);
    if (typeof wd === "string") {
      // Was relative to the old install dir; the new working directory is the
      // workspace root itself.
      doc.setIn(["service", "workingDirectory"], ".");
    }
    writeYamlDocument(newConfigPath, doc);
  } catch (err) {
    fail("config rewrite", err);
  }

  // 6. Database: prefix-swap worktree paths, then adopt legacy rows.
  const dbPath = join(plan.parentDir, ".redqueen", "redqueen.db");
  if (existsSync(dbPath)) {
    try {
      const oldPrefix = join(plan.installDir, ".redqueen", "worktrees") + "/";
      const newPrefix = join(plan.parentDir, ".redqueen", "worktrees") + "/";
      const raw = new Database(dbPath);
      try {
        raw.exec(
          "CREATE TABLE IF NOT EXISTS pipeline_repos (issue_id TEXT NOT NULL, repo TEXT NOT NULL, in_scope INTEGER NOT NULL DEFAULT 1, branch_name TEXT, pr_number INTEGER, pr_base_branch TEXT, terminal_pr_number INTEGER, worktree_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (issue_id, repo))",
        );
        for (const table of ["pipeline_state", "pipeline_repos"]) {
          raw
            .prepare(
              `UPDATE ${table}
               SET worktree_path = ? || substr(worktree_path, ?) || '/' || ?
               WHERE worktree_path LIKE ? || '%'`,
            )
            .run(newPrefix, oldPrefix.length + 1, plan.repoName, oldPrefix);
        }
      } finally {
        raw.close();
      }
      const db = new RedQueenDatabase(dbPath);
      try {
        new PipelineStateStore(db.db, [plan.repoName]).adoptLegacyRows(plan.repoName);
      } finally {
        db.close();
      }
    } catch (err) {
      fail("database rewrite", err);
    }
  }
}

export async function cmdMigrate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help === true) {
    process.stdout.write(
      "redqueen migrate — move this single-repo install up one directory into a workspace root. Flags: --dry-run --yes\n",
    );
    return;
  }
  const plan = planMigration(process.cwd());
  plan.serviceInstalled = await serviceInstalled(plan.installDir);
  printPlan(plan);
  if (values["dry-run"] === true) {
    process.stdout.write("Dry run — nothing changed.\n");
    return;
  }
  if (values.yes !== true) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const resp = (await rl.question("Proceed? [y/N]: ")).trim().toLowerCase();
      if (resp !== "y") {
        process.stdout.write("Aborted.\n");
        return;
      }
    } finally {
      rl.close();
    }
  }
  executeMigration(plan);

  // 7. The plist/unit bakes in the working directory.
  if (plan.serviceInstalled) {
    await reinstallService(plan.parentDir);
  }

  // 8. Next steps.
  process.stdout.write(
    [
      "",
      `Migrated. The install now lives at ${plan.parentDir}.`,
      "Next:",
      `  1. Review ${join(plan.parentDir, "redqueen.yaml")} (project.repos[0] is "${plan.repoName}").`,
      "  2. redqueen init --add-repo <path>   # once per sibling repo",
      "  3. Add a source-control webhook on each sibling repo (or one org-level webhook) pointing at the same URL with the same secret.",
      "  4. redqueen start",
      "",
    ].join("\n"),
  );
}

async function serviceInstalled(installDir: string): Promise<boolean> {
  try {
    loadDotEnv(installDir);
    const config = loadConfig(join(installDir, "redqueen.yaml"));
    if (config.service.enabled === false) {
      return false;
    }
    const manager = createServiceManager();
    const context = buildInstallContext(
      resolveServicePaths(config, installDir),
      resolveRedqueenBinPath(),
    );
    return (await manager.status(context)).installed;
  } catch (err) {
    if (err instanceof UnsupportedPlatformError) {
      return false;
    }
    throw err;
  }
}

async function reinstallService(rootDir: string): Promise<void> {
  loadDotEnv(rootDir);
  const config = loadConfig(join(rootDir, "redqueen.yaml"));
  const manager = createServiceManager();
  const context = buildInstallContext(
    resolveServicePaths(config, rootDir),
    resolveRedqueenBinPath(),
  );
  mkdirSync(join(rootDir, ".redqueen"), { recursive: true });
  writeWrapperScript(context.wrapperScriptPath, {
    envFilePath: context.envFilePath,
    redqueenBinPath: context.redqueenBinPath,
    nodeBinPath: process.execPath,
  });
  await manager.install(context);
  process.stdout.write(
    `Reinstalled service ${context.name} with working directory ${context.workingDirectory}.\n`,
  );
}
```

Register in `src/cli/index.ts`:

```ts
import { cmdMigrate } from "./migrate.js";
// …
    case "migrate":
      await cmdMigrate(rest);
      return;
```

`src/cli/help.ts` top-level: `  migrate                     Move a single-repo install up one directory into a workspace root (--dry-run, --yes)`, and a `COMMAND_HELP.migrate` entry describing the preconditions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/__tests__/migrate.test.ts`
Expected: PASS. If `git worktree move` complains about the destination's parent not existing on your git version, the `mkdirSync(dirname(m.to))` before each move is what fixes it — keep it.

- [ ] **Step 5: Check + commit**

```bash
npm run check
git add src/cli/migrate.ts src/cli/index.ts src/cli/help.ts src/cli/__tests__/migrate.test.ts
git commit -m "feat(cli): redqueen migrate moves a single-repo install into a workspace root"
git push
```

---

## Plan-level verification

- [ ] `npm run check` and `npx vitest run` clean.
- [ ] Manual: in a scratch parent with two cloned repos, `redqueen init --yes` writes `project.repos[]`; `redqueen init --map-only` keeps an edited "What this repo is" block; `redqueen init --add-repo ../third` appends and refuses a second time.
- [ ] Manual: in a scratch single-repo install with one coding worktree, `redqueen migrate --dry-run` prints the plan and changes nothing; `redqueen migrate --yes` moves it; `git worktree list` in the repo still shows the worktree at the nested path; `redqueen status` at the parent lists the ticket's row.

## Self-review notes

- §10 → Task 1 (sections, seeds, section-aware merge, flat unchanged). §11 → Task 3 (discovery, prompt/all with `--yes`, per-repo derivation via `parseGitRemote`/`origin/HEAD`, single tracker/auth prompt, preflight on origin, gitignore only for a repo root, git-repo cwd unchanged). §12 → Task 4 (append, duplicate refusal, legacy lift, `parseDocument`). §13 → Task 5 steps 1–8 including the reversal message and the leftover `.gitignore`. `deriveRepoName` is the only naming rule (Task 2's `deriveRepoEntry`, `liftLegacyToRepos`).
- Type consistency: `deriveRepoEntry` returns `{ entry: RepoConfig, languages, primary }`; `liftLegacyToRepos(doc, repoPath)` returns the lifted `RepoConfig`; `appendRepo(doc, entry)`; `renderRepoSection(RepoMapInput)`; `generateWorkspaceMap({ rootDir, repos, generatedAt })`.
