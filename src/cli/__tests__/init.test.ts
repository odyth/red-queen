import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { cmdInit } from "../init.js";
import * as repoDiscovery from "../repo-discovery.js";
import { parseConfig } from "../../core/config.js";
import { RedQueenDatabase } from "../../core/database.js";
import { PipelineStateStore } from "../../core/pipeline-state.js";
import { DEFAULT_PHASES } from "../../core/defaults.js";
import { LinuxServiceManager, MacServiceManager } from "../../core/service/index.js";

const { question, close } = vi.hoisted(() => ({
  question: vi.fn<(prompt: string) => Promise<string>>(),
  close: vi.fn(),
}));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question(prompt: string): Promise<string> {
      if (question.mock.calls.length > 100) {
        throw new Error("Init prompted repeatedly without accepting test answers");
      }
      return question(prompt);
    },
    close,
  }),
}));

let tmp: string;
let originalCwd: string;

beforeEach(() => {
  question.mockReset().mockResolvedValue("");
  close.mockReset();
  tmp = mkdtempSync(join(tmpdir(), "rq-init-"));
  originalCwd = process.cwd();
  // Each init run needs a fresh git repo.
  execSync("git init -q", { cwd: tmp });
  execSync("git config user.email test@example.com", { cwd: tmp });
  execSync("git config user.name Test", { cwd: tmp });
  process.chdir(tmp);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("cmdInit --yes", () => {
  it("scaffolds a working project from scratch", async () => {
    writeFileSync(
      join(tmp, "package.json"),
      '{"name":"demo","scripts":{"build":"tsc","test":"vitest"}}',
    );
    await cmdInit(["--yes"]);

    expect(existsSync(join(tmp, "redqueen.yaml"))).toBe(true);
    expect(existsSync(join(tmp, ".redqueen", "codebase-map.md"))).toBe(true);
    expect(existsSync(join(tmp, ".redqueen", "references", "coding-standards.md"))).toBe(true);
    expect(existsSync(join(tmp, ".redqueen", "references", "review-checklist.md"))).toBe(true);
    expect(existsSync(join(tmp, ".redqueen", "references", "spec-template.md"))).toBe(true);
    expect(existsSync(join(tmp, ".redqueen", "skills", ".gitkeep"))).toBe(true);

    const gitignore = readFileSync(join(tmp, ".gitignore"), "utf8");
    expect(gitignore).toContain(".redqueen/redqueen.db");
    expect(gitignore).toContain(".redqueen/worktrees/");
    expect(gitignore).toContain(".redqueen/tmp/");
    expect(gitignore).toContain(".redqueen/*.log");

    const yaml = readFileSync(join(tmp, "redqueen.yaml"), "utf8");
    // The generated yaml references ${GITHUB_PAT}; set it so parseConfig
    // can interpolate cleanly.
    process.env.GITHUB_PAT = "test-pat";
    try {
      const config = parseConfig(yaml);
      expect(config.project.buildCommand).toBe("npm run build");
      expect(config.project.testCommand).toBe("npm test");
      expect(config.pipeline.baseBranch).toMatch(/^origin\//);
    } finally {
      delete process.env.GITHUB_PAT;
    }

    // .env file should be scaffolded with the GITHUB_PAT key.
    const envContent = readFileSync(join(tmp, ".env"), "utf8");
    expect(envContent).toContain("GITHUB_PAT=");

    // .gitignore must include .env.
    expect(gitignore).toContain(".env");
  });

  it("scaffolds a .env only its owner can read", async () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    await cmdInit(["--yes"]);
    expect(statSync(join(tmp, ".env")).mode & 0o777).toBe(0o600);
  });

  it("appends the log rule to a pre-existing Red Queen gitignore", async () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    // A gitignore that has the base block but predates the log rule.
    writeFileSync(join(tmp, ".gitignore"), ".env\n.redqueen/redqueen.db\n");
    await cmdInit(["--yes"]);

    const gitignore = readFileSync(join(tmp, ".gitignore"), "utf8");
    expect(gitignore).toContain(".redqueen/*.log");
    // Base lines are not duplicated.
    expect(gitignore.match(/\.redqueen\/redqueen\.db\b/g)).toHaveLength(1);
  });

  it("refuses to run twice without --force", async () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    await cmdInit(["--yes"]);
    await expect(cmdInit(["--yes"])).rejects.toThrow(/already exists/);
  });

  it("--force overwrites the existing config", async () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    await cmdInit(["--yes"]);
    await expect(cmdInit(["--yes", "--force"])).resolves.toBeUndefined();
  });

  it("coding-standards file picks the language-specific template in --yes mode", async () => {
    writeFileSync(join(tmp, "Cargo.toml"), "[package]\nname='x'\n");
    await cmdInit(["--yes"]);
    const content = readFileSync(
      join(tmp, ".redqueen", "references", "coding-standards.md"),
      "utf8",
    );
    expect(content).toMatch(/Coding Standards — Rust/);
  });

  it("blank language falls back to blank coding-standards", async () => {
    await cmdInit(["--yes"]);
    const content = readFileSync(
      join(tmp, ".redqueen", "references", "coding-standards.md"),
      "utf8",
    );
    expect(content).toMatch(/Coding Standards \(TODO\)/);
  });
});

describe("cmdInit --map-only", () => {
  it("regenerates the codebase map while preserving Key Notes", async () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    await cmdInit(["--yes"]);

    const mapPath = join(tmp, ".redqueen", "codebase-map.md");
    const original = readFileSync(mapPath, "utf8");
    // Replace the Key Notes section with user-authored content.
    const withEdits = original.replace(
      /## Key Notes \(edit me\)[\s\S]*$/,
      "## Key Notes (edit me)\n- Custom note from human.\n",
    );
    writeFileSync(mapPath, withEdits);

    await cmdInit(["--map-only"]);

    const regenerated = readFileSync(mapPath, "utf8");
    expect(regenerated).toContain("- Custom note from human.");
    expect(regenerated).toContain("## Languages");
  });
});

describe("cmdInit --add-repo", () => {
  function git(dir: string, args: string[]): void {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  }

  function repo(root: string, name: string, upstream = `acme/${name}`): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    git(path, ["init", "-q"]);
    git(path, ["remote", "add", "origin", `git@github.com:${upstream}.git`]);
    git(path, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    return path;
  }

  async function workspace(): Promise<string> {
    const root = join(tmp, "workspace");
    repo(root, "Api");
    process.chdir(root);
    await cmdInit(["--yes"]);
    return root;
  }

  async function legacy(): Promise<void> {
    git(tmp, ["remote", "add", "origin", "git@github.com:acme/Legacy.git"]);
    git(tmp, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await cmdInit(["--yes"]);
  }

  function config(root: string): ReturnType<typeof parseConfig> {
    vi.stubEnv("GITHUB_PAT", "test-token");
    return parseConfig(readFileSync(join(root, "redqueen.yaml"), "utf8"));
  }

  async function expectUnchanged(root: string, path: string, message: RegExp): Promise<void> {
    const files = ["redqueen.yaml", ".redqueen/codebase-map.md", ".redqueen/redqueen.db"];
    const before = files.map((file) =>
      existsSync(join(root, file)) ? readFileSync(join(root, file)) : null,
    );
    await expect(cmdInit(["--add-repo", path])).rejects.toThrow(message);
    expect(
      files.map((file) => (existsSync(join(root, file)) ? readFileSync(join(root, file)) : null)),
    ).toEqual(before);
  }

  it("converts a safe legacy install using Git 2.17 worktree listing", async () => {
    await legacy();
    const path = repo(tmp, "Sibling spaces_%'", "acme/Sibling");
    const list = repoDiscovery.listRegisteredWorktrees;
    const oldGit = vi.fn((args: string[], cwd: string): string => {
      if (args[0] === "--version") {
        return "git version 2.17.0\n";
      }
      expect(args.includes("-z")).toBe(false);
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    });
    vi.spyOn(repoDiscovery, "listRegisteredWorktrees").mockImplementation((dir) =>
      list(dir, oldGit),
    );
    await cmdInit(["--add-repo", path]);
    expect(config(tmp).project.repos.map((entry) => entry.name)).toEqual(["legacy", "sibling"]);
    expect(oldGit.mock.calls.some(([args]) => args[0] === "worktree")).toBe(true);
  });

  it("refuses ambiguous older-Git listing output before a legacy add-repo conversion", async () => {
    await legacy();
    const list = repoDiscovery.listRegisteredWorktrees;
    vi.spyOn(repoDiscovery, "listRegisteredWorktrees").mockImplementation((dir) =>
      list(dir, (args, cwd) => {
        if (args[0] === "--version") {
          return "git version 2.35.0\n";
        }
        if (args[0] === "worktree") {
          return "worktree /ambiguous\npath\n\n";
        }
        return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
      }),
    );
    await expectUnchanged(tmp, repo(tmp, "Sibling"), /Cannot safely read Git worktree metadata/);
  });

  it("appends without credentials while preserving tuned YAML, map edits and file permissions", async () => {
    const root = await workspace();
    const path = repo(root, "Web");
    const yamlPath = join(root, "redqueen.yaml");
    const doc = parseDocument(readFileSync(yamlPath, "utf8"));
    doc.setIn(["pipeline", "pollInterval"], 71);
    doc.setIn(["pipeline", "cost", "pricing", "custom"], {
      input: 4,
      output: 8,
      cacheRead: 1,
      cacheCreation: 2,
    });
    doc.set("phases", doc.createNode(DEFAULT_PHASES));
    doc.setIn(["phases", 0, "maxIterations"], 7);
    doc.setIn(["issueTracker", "config", "customFields"], { phase: "customfield_10123" });
    doc.setIn(["issueTracker", "config", "phaseMapping"], { coding: "Working" });
    doc.setIn(["sourceControl", "config", "auth"], { type: "pat", token: "${ADD_REPO_UNSET_PAT}" });
    writeFileSync(yamlPath, `# Keep tuned settings\n${doc.toString()}`);
    chmodSync(yamlPath, 0o640);
    vi.stubEnv("ADD_REPO_UNSET_PAT", undefined);
    const mapPath = join(root, ".redqueen", "codebase-map.md");
    const before = readFileSync(mapPath, "utf8")
      .replace("- (describe this repo — no README.md found)", "API purpose from a human.")
      .replace("- Describe the module structure here.", "- API custom note.");
    writeFileSync(mapPath, before);

    await cmdInit(["--add-repo", path]);

    const after = readFileSync(yamlPath, "utf8");
    expect(after).toContain("# Keep tuned settings");
    expect(after).toContain("${ADD_REPO_UNSET_PAT}");
    expect(after).toContain("customfield_10123");
    expect(after).toContain("coding: Working");
    expect(after).toContain("pollInterval: 71");
    expect(after).toContain("maxIterations: 7");
    expect(after).toContain("input: 4");
    expect(statSync(yamlPath).mode & 0o777).toBe(0o640);
    const map = readFileSync(mapPath, "utf8");
    expect(map.startsWith(before)).toBe(true);
    expect(map).toContain("## Repo: web");
    vi.stubEnv("ADD_REPO_UNSET_PAT", "test-token");
    expect(config(root).project.repos.map((r) => [r.name, r.path])).toEqual([
      ["api", "./Api"],
      ["web", "./Web"],
    ]);
    await expectUnchanged(root, path, /already declares/);
  });

  it("creates a complete map when the existing map is missing", async () => {
    const root = await workspace();
    const path = repo(root, "Web");
    rmSync(join(root, ".redqueen", "codebase-map.md"));
    await cmdInit(["--add-repo", path]);
    const map = readFileSync(join(root, ".redqueen", "codebase-map.md"), "utf8");
    expect(map).toContain("## Repo: api");
    expect(map).toContain("## Repo: web");
  });

  it("resolves appended paths and map location relative to project.directory", async () => {
    const root = await workspace();
    const path = repo(root, "Web");
    renameSync(join(root, "redqueen.yaml"), join(tmp, "redqueen.yaml"));
    const doc = parseDocument(readFileSync(join(tmp, "redqueen.yaml"), "utf8"));
    doc.setIn(["project", "directory"], "./workspace");
    writeFileSync(join(tmp, "redqueen.yaml"), doc.toString());
    process.chdir(tmp);
    await cmdInit(["--add-repo", path]);
    expect(config(tmp).project.repos[1]?.path).toBe("./Web");
    expect(readFileSync(join(root, ".redqueen", "codebase-map.md"), "utf8")).toContain(
      "## Repo: web",
    );
    expect(existsSync(join(tmp, ".redqueen"))).toBe(false);
  });

  it("rejects canonical path aliases even when the configured repo name differs", async () => {
    const root = await workspace();
    const doc = parseDocument(readFileSync(join(root, "redqueen.yaml"), "utf8"));
    doc.setIn(["project", "repos", 0, "name"], "server");
    writeFileSync(join(root, "redqueen.yaml"), doc.toString());
    const alias = join(root, "Alias");
    symlinkSync(join(root, "Api"), alias, "dir");
    await expectUnchanged(root, alias, /[Dd]uplicate repo path|already declares path/);
  });

  it("rejects case-insensitive upstream duplicates after resolving identity placeholders", async () => {
    const root = await workspace();
    const doc = parseDocument(readFileSync(join(root, "redqueen.yaml"), "utf8"));
    doc.setIn(["project", "repos", 0, "name"], "server");
    doc.setIn(["project", "repos", 0, "owner"], "${ADD_REPO_OWNER}");
    doc.setIn(["project", "repos", 0, "repo"], "${ADD_REPO_REPO}");
    writeFileSync(join(root, "redqueen.yaml"), doc.toString());
    vi.stubEnv("ADD_REPO_OWNER", undefined);
    vi.stubEnv("ADD_REPO_REPO", undefined);
    writeFileSync(join(root, ".env"), "ADD_REPO_OWNER=Acme\nADD_REPO_REPO=API\n");
    await expectUnchanged(root, repo(root, "Clone", "acme/api"), /[Dd]uplicate upstream/);
  });

  it.each(["source-control", "tracker-inherited"])(
    "enforces effective %s App owner constraints without credentials",
    async (authSource) => {
      const root = await workspace();
      const doc = parseDocument(readFileSync(join(root, "redqueen.yaml"), "utf8"));
      doc.deleteIn(["sourceControl", "config", "auth"]);
      doc.deleteIn(["issueTracker", "config", "auth"]);
      const adapter = authSource === "source-control" ? "sourceControl" : "issueTracker";
      doc.setIn([adapter, "config", "auth"], {
        type: "byo-app",
        privateKeyPath: "${ADD_REPO_MISSING_KEY}",
      });
      vi.stubEnv("ADD_REPO_MISSING_KEY", undefined);
      writeFileSync(join(root, "redqueen.yaml"), doc.toString());
      await expectUnchanged(root, repo(root, "Web", "other/Web"), /App auth|App.*owner/);
    },
  );

  it("checks the paired tracker owner and allows owner casing differences", async () => {
    const root = await workspace();
    const doc = parseDocument(readFileSync(join(root, "redqueen.yaml"), "utf8"));
    doc.setIn(["sourceControl", "config", "auth"], { type: "byo-app" });
    doc.setIn(["issueTracker", "config", "owner"], "unrelated");
    writeFileSync(join(root, "redqueen.yaml"), doc.toString());
    const web = repo(root, "Web", "ACME/Web");
    await expectUnchanged(root, web, /paired.*tracker|tracker.*owner/);
    doc.setIn(["issueTracker", "config", "owner"], "Acme");
    writeFileSync(join(root, "redqueen.yaml"), doc.toString());
    await cmdInit(["--add-repo", web]);
    expect(config(root).project.repos).toHaveLength(2);
  });

  it("resolves shared App auth aliases with a Jira tracker before checking owners", async () => {
    const root = await workspace();
    const doc = parseDocument(readFileSync(join(root, "redqueen.yaml"), "utf8"));
    doc.set(
      "sharedApp",
      doc.createNode({ type: "byo-app", privateKeyPath: "${ADD_REPO_ALIAS_KEY}" }),
    );
    const app = doc.get("sharedApp", true);
    if (app === undefined || app === null) {
      throw new Error("Missing shared auth fixture");
    }
    doc.setIn(["issueTracker", "type"], "jira");
    doc.setIn(["issueTracker", "config"], { apiToken: "${ADD_REPO_JIRA_TOKEN}" });
    // Put the anchor before its alias, as required by YAML serialization.
    if (isMap(doc.contents) === false) {
      throw new Error("Missing config mapping fixture");
    }
    const pair = doc.contents.items.pop();
    if (pair === undefined) {
      throw new Error("Missing shared auth anchor fixture");
    }
    doc.contents.items.unshift(pair);
    doc.setIn(["sourceControl", "config", "auth"], doc.createAlias(app, "sharedApp"));
    writeFileSync(join(root, "redqueen.yaml"), doc.toString());
    vi.stubEnv("ADD_REPO_ALIAS_KEY", undefined);
    vi.stubEnv("ADD_REPO_JIRA_TOKEN", undefined);
    await expectUnchanged(root, repo(root, "Other", "other/Other"), /App.*owner/);
    await cmdInit(["--add-repo", repo(root, "Web")]);
    const written = readFileSync(join(root, "redqueen.yaml"), "utf8");
    expect(written).toContain("*sharedApp");
    expect(written).toContain("${ADD_REPO_ALIAS_KEY}");
  });

  it("lifts legacy fields and notes and adopts modern legacy spec-only rows", async () => {
    await legacy();
    const doc = parseDocument(readFileSync(join(tmp, "redqueen.yaml"), "utf8"));
    doc.setIn(["sourceControl", "config", "repo"], "${ADD_REPO_LEGACY_NAME}");
    writeFileSync(join(tmp, "redqueen.yaml"), doc.toString());
    vi.stubEnv("ADD_REPO_LEGACY_NAME", undefined);
    writeFileSync(join(tmp, ".env"), "ADD_REPO_LEGACY_NAME=Legacy\n");
    const mapPath = join(tmp, ".redqueen", "codebase-map.md");
    writeFileSync(
      mapPath,
      readFileSync(mapPath, "utf8").replace(
        "- Describe the module structure here.",
        "- Legacy human note.",
      ),
    );
    const dbPath = join(tmp, ".redqueen", "redqueen.db");
    const before = new RedQueenDatabase(dbPath);
    const state = new PipelineStateStore(before.db, ["legacy"]);
    state.create("#7", "spec-writing");
    before.db
      .prepare("UPDATE pipeline_state SET spec_content = 'Legacy spec' WHERE issue_id = ?")
      .run("#7");
    expect(state.listRepos("#7")).toEqual([]);
    before.close();

    await cmdInit(["--add-repo", repo(tmp, "Sibling")]);

    expect(config(tmp).project.repos.map((r) => [r.name, r.path])).toEqual([
      ["legacy", "."],
      ["sibling", "./Sibling"],
    ]);
    expect(readFileSync(join(tmp, "redqueen.yaml"), "utf8")).toContain("${ADD_REPO_LEGACY_NAME}");
    expect(readFileSync(join(tmp, "redqueen.yaml"), "utf8")).toContain(
      "# Optional: per-module commands",
    );
    expect(readFileSync(mapPath, "utf8")).toContain("- Legacy human note.");
    const after = new RedQueenDatabase(dbPath);
    try {
      expect(new PipelineStateStore(after.db, ["legacy", "sibling"]).listRepos("#7")).toMatchObject(
        [{ repo: "legacy", inScope: true }],
      );
    } finally {
      after.close();
    }
  });

  it("refuses a running legacy orchestrator before writing", async () => {
    await legacy();
    writeFileSync(join(tmp, ".redqueen", "redqueen.pid"), String(process.pid));
    await expectUnchanged(tmp, repo(tmp, "Sibling"), /running.*stop|Stop.*redqueen/);
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "refuses a running legacy service without a PID file",
    async () => {
      await legacy();
      const manager =
        process.platform === "darwin" ? MacServiceManager.prototype : LinuxServiceManager.prototype;
      vi.spyOn(manager, "status").mockResolvedValue({
        installed: true,
        running: true,
        name: "test-service",
        pid: 123,
        platform: process.platform === "darwin" ? "darwin" : "linux",
        stdoutLog: "out",
        stderrLog: "err",
      });
      await expectUnchanged(tmp, repo(tmp, "Sibling"), /service.*running.*service stop/);
    },
  );

  it("leaves legacy YAML and notes intact if database adoption fails", async () => {
    await legacy();
    const dbPath = join(tmp, ".redqueen", "redqueen.db");
    const database = new RedQueenDatabase(dbPath);
    new PipelineStateStore(database.db, ["legacy"]).create("#7", "spec-writing");
    database.db.prepare("UPDATE pipeline_state SET spec_content = 'legacy spec'").run();
    database.close();
    vi.spyOn(PipelineStateStore.prototype, "adoptLegacyRows").mockImplementation(() => {
      throw new Error("Simulated adoption failure");
    });
    await expectUnchanged(tmp, repo(tmp, "Sibling"), /Simulated adoption failure/);
    expect(config(tmp).project.workspaceMode).toBe(false);
  });

  it("keeps modern empty workspace scope empty while adding a repo", async () => {
    const root = await workspace();
    const database = new RedQueenDatabase(join(root, ".redqueen", "redqueen.db"));
    const state = new PipelineStateStore(database.db, ["api"]);
    state.create("#7", "spec-writing");
    database.db.prepare("UPDATE pipeline_state SET spec_content = 'workspace spec'").run();
    try {
      await cmdInit(["--add-repo", repo(root, "Web")]);
      expect(state.listRepos("#7")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("refuses registered flat legacy worktrees without changing worktree or config", async () => {
    await legacy();
    git(tmp, ["commit", "--allow-empty", "-m", "Initial"]);
    const worktree = join(tmp, ".redqueen", "worktrees", "spec-ISSUE-1");
    git(tmp, ["worktree", "add", "--detach", worktree, "HEAD"]);
    writeFileSync(join(worktree, "dirty.txt"), "keep my work");
    await expectUnchanged(tmp, repo(tmp, "Sibling"), /worktree.*redqueen migrate/);
    expect(readFileSync(join(worktree, "dirty.txt"), "utf8")).toBe("keep my work");
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: tmp, encoding: "utf8" }),
    ).toContain(worktree);
  });

  it("refuses state-referenced legacy worktrees even if their directory is absent", async () => {
    await legacy();
    const database = new RedQueenDatabase(join(tmp, ".redqueen", "redqueen.db"));
    new PipelineStateStore(database.db, ["legacy"]).create("#1", "coding");
    database.db
      .prepare("UPDATE pipeline_state SET worktree_path = ? WHERE issue_id = ?")
      .run(join(tmp, ".redqueen", "worktrees", "ISSUE-1"), "#1");
    database.close();
    await expectUnchanged(tmp, repo(tmp, "Sibling"), /worktree.*redqueen migrate/);
  });

  it("rejects unsupported legacy project.directory layouts", async () => {
    await legacy();
    repo(tmp, "Nested");
    const doc = parseDocument(readFileSync(join(tmp, "redqueen.yaml"), "utf8"));
    doc.setIn(["project", "directory"], "./Nested");
    writeFileSync(join(tmp, "redqueen.yaml"), doc.toString());
    await expectUnchanged(tmp, repo(tmp, "Sibling"), /project.directory.*redqueen migrate/);
  });

  it("validates an existing flat map before lifting config or adopting state", async () => {
    await legacy();
    writeFileSync(join(tmp, ".redqueen", "codebase-map.md"), "# My map without the notes marker\n");
    await expectUnchanged(tmp, repo(tmp, "Sibling"), /Key Notes.*marker/);
  });

  it("requires an existing config and rejects incompatible flags", async () => {
    const sibling = repo(tmp, "Sibling");
    await expect(cmdInit(["--add-repo", sibling])).rejects.toThrow(/existing redqueen.yaml/);
    await legacy();
    for (const flag of ["--map-only", "--force"]) {
      await expect(cmdInit(["--add-repo", sibling, flag])).rejects.toThrow(
        /cannot.*combined|combine/,
      );
    }
  });
});

describe("cmdInit workspace mode", () => {
  function git(dir: string, args: string[]): void {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  }

  function workspace(): string {
    const root = join(tmp, "ws");
    mkdirSync(root);
    for (const [dir, remote, branch] of [
      ["AlignSmart", "git@github.com:alignsmart/AlignSmart.git", "main"],
      ["EmailTemplates", "https://github.com/alignsmart/EmailTemplates.git", "trunk"],
    ] as const) {
      const path = join(root, dir);
      mkdirSync(path);
      git(path, ["init", "-q"]);
      git(path, ["remote", "add", "origin", remote]);
      git(path, ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`]);
      writeFileSync(join(path, "README.md"), `# ${dir}\n\n${dir} does things.\n`);
    }
    writeFileSync(join(root, "AlignSmart", "package.json"), '{"scripts":{"build":"x","test":"y"}}');
    writeFileSync(join(root, "EmailTemplates", "Cargo.toml"), "[package]\nname='templates'\n");
    mkdirSync(join(root, "not-a-repo"));
    process.chdir(root);
    return root;
  }

  function expectNoScaffolding(root: string): void {
    for (const path of ["redqueen.yaml", ".redqueen", ".env", ".gitignore"]) {
      expect(existsSync(join(root, path))).toBe(false);
    }
  }

  it("scaffolds each repo and one tracker with --yes without needing credentials", async () => {
    const root = workspace();
    vi.stubEnv("GITHUB_PAT", undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await cmdInit(["--yes"]);

    vi.stubEnv("GITHUB_PAT", "test-pat");
    const config = parseConfig(readFileSync(join(root, "redqueen.yaml"), "utf8"));
    expect(config.project.workspaceMode).toBe(true);
    expect(config.project.repos.map((r) => [r.name, r.path, r.owner, r.repo])).toEqual([
      ["alignsmart", "./AlignSmart", "alignsmart", "AlignSmart"],
      ["emailtemplates", "./EmailTemplates", "alignsmart", "EmailTemplates"],
    ]);
    expect(config.project.repos.map((r) => [r.buildCommand, r.testCommand, r.baseBranch])).toEqual([
      ["npm run build", "npm test", "origin/main"],
      ["cargo build", "cargo test", "origin/trunk"],
    ]);
    expect(config.project.buildCommand).toBeUndefined();
    expect(config.project.testCommand).toBeUndefined();
    expect(config.sourceControl.config.owner).toBeUndefined();
    expect(config.sourceControl.config.repo).toBeUndefined();
    expect(config.issueTracker.config.owner).toBe("alignsmart");
    expect(config.issueTracker.config.repo).toBe("AlignSmart");
    const map = readFileSync(join(root, ".redqueen", "codebase-map.md"), "utf8");
    expect(map).toContain("## Repo: alignsmart");
    expect(map).toContain("## Repo: emailtemplates");
    expect(map).toContain("AlignSmart does things.");
    expect(map).toContain("cargo build");
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
    expect(readFileSync(join(root, ".env"), "utf8")).not.toContain("gitignored");
    expect(stdout.mock.calls.map(([text]) => String(text)).join("")).not.toContain("gitignored");
    for (const file of ["coding-standards.md", "review-checklist.md", "spec-template.md"]) {
      expect(existsSync(join(root, ".redqueen", "references", file))).toBe(true);
    }
    expect(existsSync(join(root, ".redqueen", "skills", ".gitkeep"))).toBe(true);
  });

  it("prompts for selection and commands per repo, and shared settings once", async () => {
    const root = workspace();
    git(join(root, "EmailTemplates"), ["remote", "remove", "origin"]);
    question.mockImplementation((prompt) =>
      Promise.resolve(
        prompt.includes("Include EmailTemplates")
          ? "n"
          : prompt.includes("alignsmart: build command")
            ? "npm run custom-build"
            : "",
      ),
    );
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await cmdInit([]);
    vi.stubEnv("GITHUB_PAT", "test-pat");
    const config = parseConfig(readFileSync(join(root, "redqueen.yaml"), "utf8"));
    expect(config.project.repos).toHaveLength(1);
    expect(config.project.repos[0]?.buildCommand).toBe("npm run custom-build");
    expect(question.mock.calls.filter(([prompt]) => prompt.includes("GitHub owner"))).toHaveLength(
      1,
    );
    const output = stdout.mock.calls.map(([text]) => String(text)).join("");
    expect(output.match(/GitHub auth:/g)).toHaveLength(1);
    expect(output.match(/Issue tracker:/g)).toHaveLength(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses no selected repos without writing files", async () => {
    const root = workspace();
    question.mockResolvedValue("n");
    await expect(cmdInit([])).rejects.toThrow(/No repos selected/);
    expectNoScaffolding(root);
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses selected repos without an origin before any writes", async () => {
    const root = workspace();
    git(join(root, "EmailTemplates"), ["remote", "remove", "origin"]);
    await expect(cmdInit(["--yes"])).rejects.toThrow(/origin/);
    expectNoScaffolding(root);
  });

  it.each([
    ["duplicate names", "git@github.com:another/AlignSmart.git", /Duplicate repo name/],
    ["duplicate upstream identities", "git@github.com:ALIGNSMART/alignsmart.git", /upstream/],
  ])("refuses %s before writes", async (_label, remote, message) => {
    const root = workspace();
    git(join(root, "EmailTemplates"), ["remote", "set-url", "origin", remote]);
    await expect(cmdInit(["--yes"])).rejects.toThrow(message);
    expectNoScaffolding(root);
  });

  it("refuses symlink aliases of the same canonical repo path", async () => {
    const root = workspace();
    symlinkSync(join(root, "AlignSmart"), join(root, "alias"));
    await expect(cmdInit(["--yes"])).rejects.toThrow(/same.*path|Duplicate repo path/);
    expectNoScaffolding(root);
  });

  it.each(["source owners", "paired tracker owner"])(
    "refuses App auth across different %s before writes",
    async (conflict) => {
      const root = workspace();
      if (conflict === "source owners") {
        git(join(root, "EmailTemplates"), [
          "remote",
          "set-url",
          "origin",
          "git@github.com:another/EmailTemplates.git",
        ]);
      }
      question.mockImplementation((prompt) =>
        Promise.resolve(
          prompt === "Choice [1]: "
            ? "2"
            : conflict === "paired tracker owner" && prompt.startsWith("GitHub owner")
              ? "another"
              : "",
        ),
      );
      await expect(cmdInit([])).rejects.toThrow(/owner/);
      expectNoScaffolding(root);
    },
  );

  it("accepts App owners with different casing without reading a private key", async () => {
    const root = workspace();
    git(join(root, "EmailTemplates"), [
      "remote",
      "set-url",
      "origin",
      "git@github.com:AlignSmart/EmailTemplates.git",
    ]);
    question.mockImplementation((prompt) =>
      Promise.resolve(
        prompt === "Choice [1]: " ? "2" : prompt.startsWith("GitHub owner") ? "ALIGNSMART" : "",
      ),
    );
    await cmdInit([]);
    expect(readFileSync(join(root, "redqueen.yaml"), "utf8")).toContain("${GITHUB_APP_KEY_PATH}");
    expect(readFileSync(join(root, ".env"), "utf8")).toContain("GITHUB_APP_ID=");
  });

  it("validates shared webhook configuration before writes", async () => {
    const root = workspace();
    question.mockImplementation((prompt) =>
      Promise.resolve(
        prompt.startsWith("Enable webhook")
          ? "y"
          : prompt.startsWith("Webhook path")
            ? "/same-path"
            : "",
      ),
    );
    await expect(cmdInit([])).rejects.toThrow(/collide/);
    expectNoScaffolding(root);
  });

  it("keeps an existing install intact when --force preflight fails", async () => {
    const root = workspace();
    await cmdInit(["--yes"]);
    const paths = ["redqueen.yaml", ".env", ".redqueen/codebase-map.md"];
    const before = paths.map((path) => readFileSync(join(root, path), "utf8"));
    git(join(root, "EmailTemplates"), ["remote", "remove", "origin"]);
    await expect(cmdInit(["--yes", "--force"])).rejects.toThrow(/origin/);
    expect(paths.map((path) => readFileSync(join(root, path), "utf8"))).toEqual(before);
  });

  it("regenerates both repo edit blocks without resolving unrelated auth placeholders", async () => {
    const root = workspace();
    await cmdInit(["--yes"]);
    vi.stubEnv("GITHUB_PAT", undefined);
    const configPath = join(root, "redqueen.yaml");
    const doc = parseDocument(readFileSync(configPath, "utf8"));
    doc.setIn(["sourceControl", "config", "auth"], {
      type: "pat",
      token: "${RQ_UNSET_SC_SECRET}",
    });
    doc.setIn(["issueTracker", "config", "auth"], {
      type: "pat",
      token: "${RQ_UNSET_TRACKER_SECRET}",
    });
    doc.setIn(["project", "repos", 0, "buildCommand"], "npm run changed");
    writeFileSync(configPath, doc.toString());
    const mapPath = join(root, ".redqueen", "codebase-map.md");
    writeFileSync(
      mapPath,
      readFileSync(mapPath, "utf8")
        .replace("AlignSmart does things.", "Human purpose for AlignSmart.")
        .replace("EmailTemplates does things.", "Human purpose for templates.")
        .replaceAll("- Describe the module structure here.", "- Human repo note."),
    );
    await cmdInit(["--map-only"]);
    const regenerated = readFileSync(mapPath, "utf8");
    expect(regenerated).toContain("Human purpose for AlignSmart.");
    expect(regenerated).toContain("Human purpose for templates.");
    expect(regenerated.match(/- Human repo note\./g)).toHaveLength(2);
    expect(regenerated).toContain("npm run changed");
    expect(readFileSync(configPath, "utf8")).toBe(doc.toString());
  });

  it("resolves map paths and commands from project.directory and local .env", async () => {
    const root = workspace();
    await cmdInit(["--yes"]);
    vi.stubEnv("GITHUB_PAT", undefined);
    vi.stubEnv("RQ_MAP_BUILD", undefined);
    mkdirSync(join(root, "sources"));
    for (const dir of ["AlignSmart", "EmailTemplates", ".redqueen"]) {
      renameSync(join(root, dir), join(root, "sources", dir));
    }
    const configPath = join(root, "redqueen.yaml");
    const doc = parseDocument(readFileSync(configPath, "utf8"));
    doc.setIn(["project", "directory"], "./sources");
    doc.setIn(["project", "repos", 0, "buildCommand"], "${RQ_MAP_BUILD}");
    writeFileSync(configPath, doc.toString());
    writeFileSync(join(root, ".env"), "RQ_MAP_BUILD=npm run from-env\n");
    await cmdInit(["--map-only"]);
    expect(readFileSync(join(root, "sources", ".redqueen", "codebase-map.md"), "utf8")).toContain(
      "npm run from-env",
    );
    expect(existsSync(join(root, ".redqueen"))).toBe(false);
  });

  it("rejects invalid workspace paths without modifying the map", async () => {
    const root = workspace();
    await cmdInit(["--yes"]);
    vi.stubEnv("GITHUB_PAT", undefined);
    const mapPath = join(root, ".redqueen", "codebase-map.md");
    const before = readFileSync(mapPath, "utf8");
    rmSync(join(root, "EmailTemplates", ".git"), { recursive: true });
    mkdirSync(join(root, "EmailTemplates", ".git"));
    await expect(cmdInit(["--map-only"])).rejects.toThrow(/git work tree root/);
    expect(readFileSync(mapPath, "utf8")).toBe(before);
  });

  it("refuses a non-git workspace root with no repo children", async () => {
    rmSync(join(tmp, ".git"), { recursive: true });
    await expect(cmdInit(["--yes"])).rejects.toThrow(/folder that contains git repositories/);
    expectNoScaffolding(tmp);
  });

  it("preserves legacy init inside an ordinary repository subdirectory", async () => {
    const nested = join(tmp, "nested");
    mkdirSync(nested);
    process.chdir(nested);
    await cmdInit(["--yes"]);
    const doc = parseDocument(readFileSync(join(nested, "redqueen.yaml"), "utf8"));
    expect(doc.hasIn(["project", "repos"])).toBe(false);
    expect(existsSync(join(nested, ".gitignore"))).toBe(true);
  });

  it("keeps a git repository root in legacy mode even with child repositories", async () => {
    const root = workspace();
    git(root, ["init", "-q"]);
    await cmdInit(["--yes"]);
    const doc = parseDocument(readFileSync(join(root, "redqueen.yaml"), "utf8"));
    expect(doc.hasIn(["project", "repos"])).toBe(false);
    expect(readFileSync(join(root, ".redqueen", "codebase-map.md"), "utf8")).toContain(
      "# Codebase Map",
    );
  });

  it("writes shared Jira, webhook, and dashboard settings once", async () => {
    const root = workspace();
    question.mockImplementation((prompt) => {
      const answers: Record<string, string> = {
        "Choice [2]: ": "1",
        "Enable webhook receiver? [y/N]: ": "y",
        "Jira base URL (e.g. https://yourco.atlassian.net): ": "https://acme.atlassian.net",
        "Jira account email: ": "dev@example.com",
        "Jira cloud ID: ": "cloud-id",
        "Jira project key: ": "ACME",
        "Dashboard port [4400]: ": "5500",
        "Public base URL for webhooks (e.g. https://hooks.example.com, blank to skip): ":
          "https://hooks.example.com/",
        "Webhook path for issue-tracker [/webhook/issue-tracker]: ": "/jira",
        "Webhook path for source-control [/webhook/source-control]: ": "/github",
      };
      return Promise.resolve(answers[prompt] ?? "");
    });
    await cmdInit([]);
    for (const key of [
      "GITHUB_PAT",
      "JIRA_TOKEN",
      "GITHUB_WEBHOOK_SECRET",
      "JIRA_WEBHOOK_SECRET",
    ]) {
      vi.stubEnv(key, "test-value");
    }
    const config = parseConfig(readFileSync(join(root, "redqueen.yaml"), "utf8"));
    expect(config.project.repos).toHaveLength(2);
    expect(config.issueTracker).toMatchObject({
      type: "jira",
      config: { projectKey: "ACME", apiToken: "test-value", webhookSecret: "test-value" },
    });
    expect(config.pipeline.webhooks).toEqual({
      enabled: true,
      publicBaseUrl: "https://hooks.example.com",
      paths: { issueTracker: "/jira", sourceControl: "/github" },
    });
    expect(config.dashboard.port).toBe(5500);
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(env.match(/JIRA_TOKEN=/g)).toHaveLength(1);
    expect(env.match(/GITHUB_WEBHOOK_SECRET=/g)).toHaveLength(1);
    expect(
      question.mock.calls.filter(([prompt]) => prompt.startsWith("Dashboard port")),
    ).toHaveLength(1);
  });
});
