import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { parseDocument } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../core/config.js";
import { RedQueenDatabase } from "../../core/database.js";
import { PipelineStateStore } from "../../core/pipeline-state.js";
import { computeServiceName, shellSingleQuote } from "../../core/service/index.js";
import type { ServiceInstallContext, ServiceStatus } from "../../core/service/index.js";
import { cmdMigrate, executeMigration, planMigration } from "../migrate.js";
import * as repoDiscovery from "../repo-discovery.js";

const service = vi.hoisted(() => ({
  status: vi.fn<(context: ServiceInstallContext) => Promise<ServiceStatus>>(),
  stop: vi.fn<(context: ServiceInstallContext) => Promise<void>>(),
  uninstall: vi.fn<(context: ServiceInstallContext) => Promise<void>>(),
  install: vi.fn<(context: ServiceInstallContext) => Promise<void>>(),
}));

const fileFailures = vi.hoisted(() => ({ chown: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    chownSync(...args: Parameters<typeof actual.chownSync>) {
      if (fileFailures.chown) {
        throw new Error("Injected directory ownership failure");
      }
      actual.chownSync(...args);
    },
  };
});

vi.mock("../../core/service/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/service/index.js")>()),
  createServiceManager: () => service,
}));

let parent: string;
let install: string;
let stateRoot: string;
let originalCwd: string;

function git(args: string[], cwd = install): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function editConfig(edit: (doc: ReturnType<typeof parseDocument>) => void): void {
  const path = join(install, "redqueen.yaml");
  const doc = parseDocument(readFileSync(path, "utf8"));
  edit(doc);
  writeFileSync(path, doc.toString());
}

function status(context: ServiceInstallContext, installed = false, running = false): ServiceStatus {
  return {
    installed,
    running,
    name: context.name,
    pid: null,
    platform: "darwin",
    stdoutLog: context.stdoutLogPath,
    stderrLog: context.stderrLogPath,
  };
}

function withDb(root: string, run: (db: Database.Database) => void): void {
  const db = new Database(join(root, ".redqueen", "redqueen.db"));
  try {
    run(db);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  fileFailures.chown = false;
  vi.resetAllMocks();
  service.status.mockImplementation((context) => Promise.resolve(status(context)));
  service.stop.mockResolvedValue();
  service.uninstall.mockResolvedValue();
  service.install.mockResolvedValue();
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  originalCwd = process.cwd();
  parent = realpathSync(mkdtempSync(join(tmpdir(), "rq migration_%'-")));
  install = join(parent, "My_App");
  stateRoot = join(install, ".redqueen");
  mkdirSync(install);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "migration@example.invalid"]);
  git(["config", "user.name", "Migration Test"]);
  writeFileSync(join(install, "README.md"), "# My App\n\nAn app worth preserving.\n");
  writeFileSync(join(install, ".gitignore"), ".redqueen/\n.env\nredqueen.yaml\n");
  git(["add", "."]);
  git(["commit", "-qm", "initial"]);
  git(["remote", "add", "origin", "git@github.com:acme/My_App.git"]);
  writeFileSync(
    join(install, "redqueen.yaml"),
    [
      "# tuned by hand",
      "issueTracker:",
      "  type: mock",
      "sourceControl:",
      "  type: github",
      "  config:",
      "    owner: ${MIGRATION_OWNER}",
      "    repo: ${MIGRATION_REPO} # keep identity placeholder",
      "    auth: { type: pat, token: '${MIGRATION_UNSET_TOKEN}' }",
      "project:",
      "  directory: . # normalize me",
      "  buildCommand: npm run build",
      "  testCommand: npm test",
      "pipeline:",
      "  baseBranch: origin/main",
      "  cost:",
      "    enabled: true # keep cost tuning",
      "service:",
      "  workingDirectory: . # keep working directory comment",
      "",
    ].join("\n"),
    { mode: 0o640 },
  );
  writeFileSync(join(install, ".env"), "MIGRATION_OWNER=acme\nMIGRATION_REPO=My_App\n", {
    mode: 0o600,
  });
  mkdirSync(join(stateRoot, "worktrees"), { recursive: true });
  for (const name of ["PROJ-1", "spec-PROJ-2", "refresh-PROJ-3"]) {
    git(["worktree", "add", "-q", "--detach", join(stateRoot, "worktrees", name), "main"]);
  }
  writeFileSync(join(stateRoot, "worktrees", "PROJ-1", "README.md"), "Dirty tracked work\n");
  writeFileSync(join(stateRoot, "worktrees", "PROJ-1", "draft.txt"), "Untracked work\n");
  writeFileSync(
    join(stateRoot, "codebase-map.md"),
    "# Codebase Map\n\n## Key Notes (edit me)\nKeep this team-specific guidance.\n",
  );
  const db = new RedQueenDatabase(join(stateRoot, "redqueen.db"));
  const store = new PipelineStateStore(db.db, ["my-app"]);
  store.create("PROJ-1", "coding");
  db.db
    .prepare("UPDATE pipeline_state SET branch_name = ?, worktree_path = ? WHERE issue_id = ?")
    .run("feature/PROJ-1", join(stateRoot, "worktrees", "PROJ-1"), "PROJ-1");
  store.create("PROJ-2", "spec-review");
  db.db
    .prepare(
      "UPDATE pipeline_state SET spec_content = 'Modern legacy spec' WHERE issue_id = 'PROJ-2'",
    )
    .run();
  db.close();
  process.chdir(install);
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(parent, { recursive: true, force: true });
});

describe("migration", () => {
  it("migrates real dirty worktrees through the Git 2.17 listing fallback", async () => {
    const list = repoDiscovery.listRegisteredWorktrees;
    const oldGit = vi.fn((args: string[], cwd: string): string => {
      if (args[0] === "--version") {
        return "git version 2.17.0\n";
      }
      expect(args.includes("-z")).toBe(false);
      return git(args, cwd);
    });
    vi.spyOn(repoDiscovery, "listRegisteredWorktrees").mockImplementation((dir) =>
      list(dir, oldGit),
    );
    await cmdMigrate(["--yes"]);
    expect(
      readFileSync(join(parent, ".redqueen", "worktrees", "PROJ-1", "my-app", "draft.txt"), "utf8"),
    ).toBe("Untracked work\n");
    expect(oldGit.mock.calls.some(([args]) => args[0] === "worktree")).toBe(true);
  });

  it("dry-runs without changing install files, Git registration, environment, or services", async () => {
    const yaml = readFileSync(join(install, "redqueen.yaml"));
    const db = readFileSync(join(stateRoot, "redqueen.db"));
    const entries = readdirSync(stateRoot);
    const registrations = git(["worktree", "list", "--porcelain", "-z"]);
    await cmdMigrate(["--dry-run"]);
    expect(readFileSync(join(install, "redqueen.yaml"))).toEqual(yaml);
    expect(readFileSync(join(stateRoot, "redqueen.db"))).toEqual(db);
    expect(readdirSync(stateRoot)).toEqual(entries);
    expect(git(["worktree", "list", "--porcelain", "-z"])).toBe(registrations);
    expect(existsSync(join(parent, ".redqueen"))).toBe(false);
    expect(process.env.MIGRATION_REPO).toBeUndefined();
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(service.uninstall).not.toHaveBeenCalled();
  });

  it("validates a database with pending WAL content without changing its sidecars", async () => {
    const db = new Database(join(stateRoot, "redqueen.db"));
    try {
      db.pragma("wal_autocheckpoint = 0");
      db.prepare(
        "UPDATE pipeline_state SET spec_content = 'Pending WAL content' WHERE issue_id = 'PROJ-2'",
      ).run();
      const wal = readFileSync(join(stateRoot, "redqueen.db-wal"));
      const shm = readFileSync(join(stateRoot, "redqueen.db-shm"));
      await cmdMigrate(["--dry-run"]);
      expect(readFileSync(join(stateRoot, "redqueen.db-wal"))).toEqual(wal);
      expect(readFileSync(join(stateRoot, "redqueen.db-shm"))).toEqual(shm);
    } finally {
      db.close();
    }
  });

  it("retains identity and relative key paths when source control and tracker share YAML aliases", async () => {
    writeFileSync(
      join(install, "redqueen.yaml"),
      [
        "identity: &repository ${MIGRATION_REPO}",
        "sourceControl:",
        "  type: github",
        "  config: &shared",
        "    owner: ${MIGRATION_OWNER}",
        "    repo: *repository",
        "    auth: { type: byo-app, appId: 1, installationId: 2, privateKeyPath: keys/app.pem }",
        "issueTracker:",
        "  type: github-issues",
        "  config: *shared",
        "project:",
        "  buildCommand: npm run build",
        "  testCommand: npm test",
        "",
      ].join("\n"),
    );
    await cmdMigrate(["--yes"]);
    vi.stubEnv("MIGRATION_OWNER", "acme");
    vi.stubEnv("MIGRATION_REPO", "My_App");
    const config = parseConfig(readFileSync(join(parent, "redqueen.yaml"), "utf8"));
    expect(config.project.repos[0]?.name).toBe("my-app");
    expect(config.issueTracker.config).toMatchObject({
      owner: "acme",
      repo: "My_App",
      auth: { privateKeyPath: "My_App/keys/app.pem" },
    });
    expect(config.sourceControl.config).toMatchObject({
      auth: { privateKeyPath: "My_App/keys/app.pem" },
    });
  });

  it("migrates dirty coding/spec worktrees, config/env/state and map notes", async () => {
    editConfig((doc) => {
      doc.setIn(["project", "directory"], install);
    });
    await cmdMigrate(["--yes"]);
    const coding = join(parent, ".redqueen", "worktrees", "PROJ-1", "my-app");
    const spec = join(parent, ".redqueen", "worktrees", "spec-PROJ-2", "my-app");
    expect(readFileSync(join(coding, "README.md"), "utf8")).toBe("Dirty tracked work\n");
    expect(readFileSync(join(coding, "draft.txt"), "utf8")).toBe("Untracked work\n");
    const registrations = git(["worktree", "list", "--porcelain", "-z"]);
    expect(registrations).toContain(coding);
    expect(registrations).toContain(spec);
    expect(registrations).not.toContain("refresh-PROJ-3");
    expect(existsSync(stateRoot)).toBe(false);
    expect(existsSync(join(install, "redqueen.yaml"))).toBe(false);
    expect(readFileSync(join(parent, ".env"), "utf8")).toContain("MIGRATION_REPO=My_App");
    expect(statSync(join(parent, ".env")).mode & 0o777).toBe(0o600);
    const yaml = readFileSync(join(parent, "redqueen.yaml"), "utf8");
    expect(yaml).toContain("# tuned by hand");
    expect(yaml).toContain("# keep cost tuning");
    expect(yaml).toContain("# keep identity placeholder");
    expect(yaml).toContain("${MIGRATION_REPO}");
    expect(yaml).toContain("${MIGRATION_UNSET_TOKEN}");
    expect(statSync(join(parent, "redqueen.yaml")).mode & 0o777).toBe(0o640);
    vi.stubEnv("MIGRATION_OWNER", "acme");
    vi.stubEnv("MIGRATION_REPO", "My_App");
    vi.stubEnv("MIGRATION_UNSET_TOKEN", "only-for-validation");
    const config = parseConfig(yaml);
    expect(config.project.directory).toBe(".");
    expect(config.project.repos[0]).toMatchObject({
      name: "my-app",
      path: "./My_App",
      owner: "acme",
      repo: "My_App",
      baseBranch: "origin/main",
    });
    expect(config.service.workingDirectory).toBe(".");
    const map = readFileSync(join(parent, ".redqueen", "codebase-map.md"), "utf8");
    expect(map).toContain("## Repo: my-app");
    expect(map).toContain("Keep this team-specific guidance.");
    withDb(parent, (db) => {
      expect(
        db.prepare("SELECT worktree_path FROM pipeline_state WHERE issue_id = 'PROJ-1'").get(),
      ).toEqual({ worktree_path: coding });
      expect(
        db
          .prepare(
            "SELECT repo, worktree_path, in_scope FROM pipeline_repos WHERE issue_id = 'PROJ-1'",
          )
          .get(),
      ).toEqual({ repo: "my-app", worktree_path: coding, in_scope: 1 });
      expect(
        db.prepare("SELECT repo, in_scope FROM pipeline_repos WHERE issue_id = 'PROJ-2'").get(),
      ).toEqual({ repo: "my-app", in_scope: 1 });
    });
  });

  it("ignores the moved secrets and state when the destination is inside a git work tree", async () => {
    git(["init", "-q"], parent);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await cmdMigrate(["--dry-run"]);
    expect(stdout.mock.calls.map(([text]) => String(text)).join("")).toContain(
      join(parent, ".gitignore"),
    );
    expect(existsSync(join(parent, ".gitignore"))).toBe(false);

    await cmdMigrate(["--yes"]);
    for (const path of [".env", ".redqueen/redqueen.db", ".redqueen/worktrees/PROJ-1"]) {
      expect(git(["check-ignore", path], parent).trim()).toBe(path);
    }
  });

  it("leaves a destination outside git without a .gitignore", async () => {
    await cmdMigrate(["--yes"]);
    expect(existsSync(join(parent, ".gitignore"))).toBe(false);
  });

  it("warns about a .env other users can read and keeps its mode", async () => {
    chmodSync(join(install, ".env"), 0o644);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await cmdMigrate(["--yes"]);
    expect(stdout.mock.calls.map(([text]) => String(text)).join("")).toMatch(
      /\.env is readable by other users \(mode 644\)/,
    );
    expect(statSync(join(parent, ".env")).mode & 0o777).toBe(0o644);
  });

  it("does not warn about a private .env", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await cmdMigrate(["--dry-run"]);
    expect(stdout.mock.calls.map(([text]) => String(text)).join("")).not.toContain(
      "readable by other users",
    );
  });

  it("warns about single-repo skill overrides the workspace stops running", async () => {
    vi.stubEnv("HOME", parent);
    for (const name of ["coder", "reviewer", "reviewer-workspace", "security-audit"]) {
      mkdirSync(join(stateRoot, "skills", name), { recursive: true });
      writeFileSync(join(stateRoot, "skills", name, "SKILL.md"), `# custom ${name}\n`);
    }
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await cmdMigrate(["--dry-run"]);
    const output = stdout.mock.calls.map(([text]) => String(text)).join("");
    expect(output).toContain("single-repo prompts and stop running after migration");
    expect(output).toContain(`  coder: ${join(stateRoot, "skills", "coder", "SKILL.md")}`);
    // Already ported, and a custom skill with no bundled variant, keep running.
    expect(output).not.toContain("  reviewer: ");
    expect(output).not.toContain("security-audit");
  });

  it("does not warn when no bundled skill is overridden", async () => {
    vi.stubEnv("HOME", parent);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await cmdMigrate(["--dry-run"]);
    expect(stdout.mock.calls.map(([text]) => String(text)).join("")).not.toContain(
      "single-repo prompts",
    );
  });

  it("preserves unknown files and unregistered refresh folders in the old worktree root", async () => {
    const unknown = join(stateRoot, "worktrees", "refresh-user-notes");
    mkdirSync(unknown);
    writeFileSync(join(unknown, "notes.txt"), "Do not delete me");
    writeFileSync(join(stateRoot, "worktrees", "scratch.txt"), "Local scratch");
    await cmdMigrate(["--yes"]);
    expect(readFileSync(join(unknown, "notes.txt"), "utf8")).toBe("Do not delete me");
    expect(readFileSync(join(stateRoot, "worktrees", "scratch.txt"), "utf8")).toBe("Local scratch");
    expect(readdirSync(stateRoot)).toEqual(["worktrees"]);
  });

  it.each(["relative external", "nested relative external", "absolute moved state"])(
    "refuses %s symlinks whose targets would change after migration",
    (kind) => {
      mkdirSync(join(install, "keys"));
      writeFileSync(join(install, "keys", "app.pem"), "Private key");
      let link: string;
      if (kind === "relative external") {
        link = join(stateRoot, "keys");
        symlinkSync("../keys", link);
      } else if (kind === "nested relative external") {
        mkdirSync(join(stateRoot, "skills"));
        link = join(stateRoot, "skills", "keys");
        symlinkSync("../../keys", link);
      } else {
        mkdirSync(join(stateRoot, "keys"));
        writeFileSync(join(stateRoot, "keys", "app.pem"), "Private key");
        link = join(stateRoot, "app.pem");
        symlinkSync(join(stateRoot, "keys", "app.pem"), link);
      }
      expect(() => planMigration(install)).toThrow(/Cannot migrate symlink.*Use a relative link/);
      expect(existsSync(link)).toBe(true);
      expect(existsSync(join(parent, ".redqueen"))).toBe(false);
      expect(existsSync(join(stateRoot, "worktrees", "refresh-PROJ-3"))).toBe(true);
    },
  );

  it("preserves symlinks within moved state and absolute links to stationary external data", () => {
    mkdirSync(join(stateRoot, "keys"));
    writeFileSync(join(stateRoot, "keys", "app.pem"), "Moved key");
    symlinkSync("keys/app.pem", join(stateRoot, "app.pem"));
    mkdirSync(join(install, "keys"));
    writeFileSync(join(install, "keys", "external.pem"), "External key");
    symlinkSync(join(install, "keys"), join(stateRoot, "external-keys"));
    editConfig((doc) => {
      doc.setIn(["sourceControl", "config", "auth", "privateKeyPath"], ".redqueen/app.pem");
      doc.setIn(
        ["issueTracker", "config", "auth", "privateKeyPath"],
        ".redqueen/external-keys/external.pem",
      );
    });
    executeMigration(planMigration(install));
    expect(readFileSync(join(parent, ".redqueen", "app.pem"), "utf8")).toBe("Moved key");
    expect(readFileSync(join(parent, ".redqueen", "external-keys", "external.pem"), "utf8")).toBe(
      "External key",
    );
  });

  it.each(["relative", "absolute", "nested absolute", "file link"])(
    "refuses a configured %s reference through an unmoved link into moved state",
    async (kind) => {
      mkdirSync(join(stateRoot, "keys"));
      writeFileSync(join(stateRoot, "keys", "app.pem"), "Keep the private key");
      let configuredPath = "keys/app.pem";
      if (kind === "nested absolute") {
        mkdirSync(join(install, "actual-auth"));
        symlinkSync("actual-auth", join(install, "credentials"));
        symlinkSync("../.redqueen/keys", join(install, "actual-auth", "keys"));
        configuredPath = join(install, "credentials", "keys", "app.pem");
      } else if (kind === "file link") {
        symlinkSync(".redqueen/keys/app.pem", join(install, "app.pem"));
        configuredPath = "app.pem";
      } else {
        symlinkSync(".redqueen/keys", join(install, "keys"));
        if (kind === "absolute") {
          configuredPath = join(install, configuredPath);
        }
      }
      editConfig((doc) => {
        doc.setIn(["sourceControl", "config", "auth", "privateKeyPath"], configuredPath);
      });
      expect(readFileSync(resolve(install, configuredPath), "utf8")).toBe("Keep the private key");
      const originalConfig = readFileSync(join(install, "redqueen.yaml"), "utf8");
      await expect(cmdMigrate(["--yes"])).rejects.toThrow(
        /sourceControl.config.auth.privateKeyPath.*symlink component.*Point the configured path directly/,
      );
      expect(readFileSync(join(install, "redqueen.yaml"), "utf8")).toBe(originalConfig);
      expect(readFileSync(resolve(install, configuredPath), "utf8")).toBe("Keep the private key");
      expect(existsSync(join(parent, ".redqueen"))).toBe(false);
      expect(existsSync(join(stateRoot, "worktrees", "refresh-PROJ-3"))).toBe(true);
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.uninstall).not.toHaveBeenCalled();
    },
  );

  it("preserves a configured unmoved symlink whose external target stays in place", async () => {
    mkdirSync(join(install, "external-keys"));
    writeFileSync(join(install, "external-keys", "app.pem"), "Stationary key");
    symlinkSync("external-keys", join(install, "keys"));
    editConfig((doc) => {
      doc.setIn(["sourceControl", "config", "auth", "privateKeyPath"], "keys/app.pem");
    });
    await cmdMigrate(["--yes"]);
    const doc = parseDocument(readFileSync(join(parent, "redqueen.yaml"), "utf8"));
    const keyPath = doc.getIn(["sourceControl", "config", "auth", "privateKeyPath"]);
    expect(keyPath).toBe("My_App/keys/app.pem");
    expect(readFileSync(resolve(parent, String(keyPath)), "utf8")).toBe("Stationary key");
  });

  it("validates default skills references through a chain that leaves and reenters moved state", () => {
    mkdirSync(join(stateRoot, "actual-skills"));
    writeFileSync(join(stateRoot, "actual-skills", "SKILL.md"), "Keep these skills");
    symlinkSync(".redqueen/actual-skills", join(install, "skills-alias"));
    symlinkSync(join(install, "skills-alias"), join(stateRoot, "skills"));
    expect(readFileSync(join(stateRoot, "skills", "SKILL.md"), "utf8")).toBe("Keep these skills");
    expect(() => planMigration(install)).toThrow(/skills.directory.*symlink component/);
    expect(existsSync(join(parent, ".redqueen"))).toBe(false);
    expect(readFileSync(join(stateRoot, "skills", "SKILL.md"), "utf8")).toBe("Keep these skills");
  });

  it("rewrites both tables by literal worktree identity without SQL wildcard matches", async () => {
    const original = join(stateRoot, "worktrees", "PROJ-1");
    const unrelated = original.replace("My_App", "MyZApp");
    withDb(install, (db) => {
      new PipelineStateStore(db, ["my-app"]).adoptLegacyRows("my-app", true);
      db.prepare(
        "INSERT INTO pipeline_state (issue_id, worktree_path, created_at, updated_at) VALUES ('OTHER', ?, 'now', 'now')",
      ).run(unrelated);
    });
    await cmdMigrate(["--yes"]);
    withDb(parent, (db) => {
      const target = join(parent, ".redqueen", "worktrees", "PROJ-1", "my-app");
      for (const table of ["pipeline_state", "pipeline_repos"]) {
        expect(
          db.prepare(`SELECT worktree_path FROM ${table} WHERE issue_id = 'PROJ-1'`).get(),
        ).toEqual({ worktree_path: target });
        expect(
          db.prepare(`SELECT worktree_path FROM ${table} WHERE issue_id = 'OTHER'`).get(),
        ).toEqual({ worktree_path: unrelated });
      }
    });
  });

  it.each(["redqueen.yaml", ".redqueen", ".env"])(
    "refuses a destination %s before any moves",
    async (name) => {
      writeFileSync(join(parent, name), "Do not overwrite");
      await expect(cmdMigrate(["--yes"])).rejects.toThrow(/already exists/);
      expect(existsSync(join(install, "redqueen.yaml"))).toBe(true);
      expect(existsSync(join(stateRoot, "worktrees", "refresh-PROJ-3"))).toBe(true);
    },
  );

  it("refuses dangling destination symlinks", () => {
    symlinkSync(join(parent, "missing"), join(parent, ".env"));
    expect(() => planMigration(install)).toThrow(/already exists/);
  });

  it("checks a running PID and locked worktrees before moving anything", () => {
    writeFileSync(join(stateRoot, "redqueen.pid"), String(process.pid));
    expect(() => planMigration(install)).toThrow(/orchestrator is running/);
    rmSync(join(stateRoot, "redqueen.pid"));
    git(["worktree", "lock", join(stateRoot, "worktrees", "PROJ-1")]);
    expect(() => planMigration(install)).toThrow(/locked worktree/);
  });

  it("validates the database and map before any moves", () => {
    const map = join(stateRoot, "codebase-map.md");
    rmSync(map);
    mkdirSync(map);
    expect(() => planMigration(install)).toThrow(/regular file/);
    rmSync(map, { recursive: true });
    writeFileSync(join(stateRoot, "redqueen.db"), "corrupt database");
    expect(() => planMigration(install)).toThrow();
    expect(existsSync(join(stateRoot, "worktrees", "refresh-PROJ-3"))).toBe(true);
  });

  it("revalidates destination collisions, changed config, and a newly running PID at execution", () => {
    const plan = planMigration(install);
    writeFileSync(join(parent, ".env"), "Created after confirmation");
    expect(() => {
      executeMigration(plan);
    }).toThrow(/already exists/);
    rmSync(join(parent, ".env"));
    editConfig((doc) => {
      doc.setIn(["pipeline", "pollInterval"], 99);
    });
    expect(() => {
      executeMigration(plan);
    }).toThrow(/changed after/);
    const revised = planMigration(install);
    writeFileSync(join(stateRoot, "redqueen.pid"), String(process.pid));
    expect(() => {
      executeMigration(revised);
    }).toThrow(/orchestrator is running/);
  });

  it("preserves relative/absolute auth, skills, audit, service and executable path meanings", () => {
    editConfig((doc) => {
      doc.setIn(["sourceControl", "config", "auth", "privateKeyPath"], "keys/sc.pem");
      doc.setIn(
        ["issueTracker", "config", "auth", "privateKeyPath"],
        join(stateRoot, "keys", "tracker.pem"),
      );
      doc.setIn(["skills", "directory"], "custom-skills");
      doc.setIn(["audit", "logFile"], "../audit/custom.log");
      doc.setIn(["service", "envFile"], "config/custom.env");
      doc.setIn(["service", "stdoutLog"], join(stateRoot, "stdout.log"));
      doc.setIn(["service", "stderrLog"], "logs/stderr.log");
      doc.setIn(["pipeline", "claudeBin"], "bin/claude");
      doc.setIn(["pipeline", "codexBin"], join(stateRoot, "bin", "codex"));
    });
    const plan = planMigration(install);
    const doc = parseDocument(plan.configYaml);
    expect(doc.getIn(["sourceControl", "config", "auth", "privateKeyPath"])).toBe(
      "My_App/keys/sc.pem",
    );
    expect(doc.getIn(["issueTracker", "config", "auth", "privateKeyPath"])).toBe(
      join(parent, ".redqueen", "keys", "tracker.pem"),
    );
    expect(doc.getIn(["skills", "directory"])).toBe("My_App/custom-skills");
    expect(resolve(parent, ".redqueen", String(doc.getIn(["audit", "logFile"])))).toBe(
      join(install, "audit", "custom.log"),
    );
    expect(plan.newService.envFilePath).toBe(join(install, "config", "custom.env"));
    expect(plan.newService.stdoutLogPath).toBe(join(parent, ".redqueen", "stdout.log"));
    expect(plan.newService.stderrLogPath).toBe(join(install, "logs", "stderr.log"));
    expect(doc.getIn(["pipeline", "claudeBin"])).toBe("My_App/bin/claude");
    expect(doc.getIn(["pipeline", "codexBin"])).toBe(join(parent, ".redqueen", "bin", "codex"));
  });

  it("relocates absolute paths written through an alias of the install root", () => {
    const alias = join(parent, "install-alias");
    symlinkSync(install, alias);
    editConfig((doc) => {
      doc.setIn(["project", "directory"], alias);
      doc.setIn(["skills", "directory"], join(alias, ".redqueen", "skills"));
      doc.setIn(
        ["sourceControl", "config", "auth", "privateKeyPath"],
        join(alias, ".redqueen", "keys", "app.pem"),
      );
    });
    const doc = parseDocument(planMigration(install).configYaml);
    expect(doc.getIn(["skills", "directory"])).toBe(join(parent, ".redqueen", "skills"));
    expect(doc.getIn(["sourceControl", "config", "auth", "privateKeyPath"])).toBe(
      join(parent, ".redqueen", "keys", "app.pem"),
    );
  });

  it("preserves relative environment path placeholders and refuses ambiguous moved absolute placeholders", () => {
    vi.stubEnv("MIGRATION_KEY_PATH", "keys/app.pem");
    editConfig((doc) => {
      doc.setIn(["sourceControl", "config", "auth", "privateKeyPath"], "${MIGRATION_KEY_PATH}");
    });
    expect(planMigration(install).configYaml).toContain("My_App/${MIGRATION_KEY_PATH}");
    vi.stubEnv("MIGRATION_KEY_PATH", join(stateRoot, "keys", "app.pem"));
    expect(() => planMigration(install)).toThrow(
      /sourceControl.config.auth.privateKeyPath.*relative literal path/,
    );
    expect(readFileSync(join(install, "redqueen.yaml"), "utf8")).toContain("${MIGRATION_KEY_PATH}");
    expect(existsSync(join(parent, ".redqueen"))).toBe(false);
  });

  it("keeps bare executable names while relocating only explicit filesystem paths", () => {
    editConfig((doc) => {
      doc.setIn(["pipeline", "claudeBin"], "claude");
      doc.setIn(["pipeline", "codexBin"], "codex");
    });
    const doc = parseDocument(planMigration(install).configYaml);
    expect(doc.getIn(["pipeline", "claudeBin"])).toBe("claude");
    expect(doc.getIn(["pipeline", "codexBin"])).toBe("codex");
  });

  it("preserves state/worktree parent permissions and ownership before moving protected files", () => {
    chmodSync(stateRoot, 0o700);
    chmodSync(join(stateRoot, "worktrees"), 0o750);
    writeFileSync(join(stateRoot, "private-key.pem"), "Protected by parent permissions", {
      mode: 0o644,
    });
    const oldState = statSync(stateRoot);
    const oldWorktrees = statSync(join(stateRoot, "worktrees"));
    const plan = planMigration(install);
    executeMigration(plan);
    const newState = statSync(join(parent, ".redqueen"));
    const newWorktrees = statSync(join(parent, ".redqueen", "worktrees"));
    expect([newState.mode, newState.uid, newState.gid]).toEqual([
      oldState.mode,
      oldState.uid,
      oldState.gid,
    ]);
    expect([newWorktrees.mode, newWorktrees.uid, newWorktrees.gid]).toEqual([
      oldWorktrees.mode,
      oldWorktrees.uid,
      oldWorktrees.gid,
    ]);
    expect(readFileSync(join(parent, ".redqueen", "private-key.pem"), "utf8")).toBe(
      "Protected by parent permissions",
    );
  });

  it("leaves original data intact if destination directory ownership cannot be retained", () => {
    const plan = planMigration(install);
    fileFailures.chown = true;
    expect(() => {
      executeMigration(plan);
    }).toThrow(/directory ownership failure/);
    expect(readFileSync(join(stateRoot, "worktrees", "PROJ-1", "draft.txt"), "utf8")).toBe(
      "Untracked work\n",
    );
    expect(existsSync(join(install, "redqueen.yaml"))).toBe(true);
    expect(readdirSync(join(parent, ".redqueen"))).toEqual([]);
  });

  it("reports shell-quoted reverse moves and completed file moves after a partial failure", () => {
    const plan = planMigration(install);
    let count = 0;
    let message = "";
    try {
      executeMigration(plan, {
        moveFile: (from, to) => {
          count += 1;
          if (count === 2) {
            throw new Error("Injected move failure");
          }
          renameSync(from, to);
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Injected move failure");
    expect(message).toContain("Files already moved");
    expect(message).toContain(`git -C ${shellSingleQuote(install)} worktree move`);
    for (const line of message
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("  mkdir ") || line.startsWith("  git ") || line.startsWith("  mv "),
      )) {
      execFileSync("/bin/sh", ["-c", line], { stdio: "pipe" });
    }
    expect(existsSync(join(stateRoot, "worktrees", "PROJ-1", "draft.txt"))).toBe(true);
    expect(existsSync(join(stateRoot, "codebase-map.md"))).toBe(true);
  });

  it("keeps the installed unit identity, unloads first, and installs after all state changes", async () => {
    editConfig((doc) => {
      doc.setIn(["service", "enabled"], true);
    });
    service.status.mockImplementation((context) => Promise.resolve(status(context, true)));
    service.stop.mockImplementation(() => {
      expect(existsSync(join(install, "redqueen.yaml"))).toBe(true);
      expect(existsSync(join(parent, ".redqueen"))).toBe(false);
      return Promise.resolve();
    });
    service.install.mockImplementation((context) => {
      expect(context.name).toBe(computeServiceName(install));
      expect(context.name).not.toBe(computeServiceName(parent));
      expect(context.workingDirectory).toBe(parent);
      expect(context.envFilePath).toBe(join(parent, ".env"));
      const doc = parseDocument(readFileSync(join(parent, "redqueen.yaml"), "utf8"));
      expect(doc.getIn(["service", "name"])).toBe(context.name);
      expect(doc.getIn(["project", "directory"])).toBe(".");
      expect(readFileSync(join(parent, ".redqueen", "codebase-map.md"), "utf8")).toContain(
        "Keep this team-specific guidance.",
      );
      withDb(parent, (db) => {
        expect(
          db.prepare("SELECT repo FROM pipeline_repos WHERE issue_id = 'PROJ-2'").get(),
        ).toEqual({ repo: "my-app" });
      });
      expect(existsSync(context.wrapperScriptPath)).toBe(true);
      return Promise.resolve();
    });
    await cmdMigrate(["--yes"]);
    expect(service.stop).toHaveBeenCalledOnce();
    expect(service.install).toHaveBeenCalledOnce();
    expect(service.uninstall).not.toHaveBeenCalled();
  });

  it("uninstalls a disabled but still installed service without starting it", async () => {
    service.status.mockImplementation((context) => Promise.resolve(status(context, true)));
    service.uninstall.mockImplementation(() => {
      service.status.mockImplementation((context) => Promise.resolve(status(context)));
      return Promise.resolve();
    });
    await cmdMigrate(["--yes"]);
    expect(service.uninstall).toHaveBeenCalledOnce();
    expect(service.install).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
    expect(
      parseDocument(readFileSync(join(parent, "redqueen.yaml"), "utf8")).getIn(["service", "name"]),
    ).toBe(computeServiceName(install));
  });

  it("keeps an explicit service-name environment placeholder", async () => {
    vi.stubEnv("MIGRATION_SERVICE_NAME", "sh.redqueen.migration-test");
    editConfig((doc) => {
      doc.setIn(["service", "name"], "${MIGRATION_SERVICE_NAME}");
      doc.setIn(["service", "enabled"], true);
    });
    service.status.mockImplementation((context) => Promise.resolve(status(context, true)));
    await cmdMigrate(["--yes"]);
    expect(readFileSync(join(parent, "redqueen.yaml"), "utf8")).toContain(
      "${MIGRATION_SERVICE_NAME}",
    );
    expect(service.install.mock.calls[0]?.[0].name).toBe("sh.redqueen.migration-test");
  });

  it("refuses to overwrite a service wrapper symlink during reinstall", async () => {
    editConfig((doc) => {
      doc.setIn(["service", "enabled"], true);
    });
    const script = join(install, "external-script.sh");
    writeFileSync(script, "Keep this external script\n");
    symlinkSync(script, join(stateRoot, "run-redqueen.sh"));
    service.status.mockImplementation((context) => Promise.resolve(status(context, true)));
    await expect(cmdMigrate(["--yes"])).rejects.toThrow(/run-redqueen.sh must be a regular file/);
    expect(existsSync(join(parent, ".redqueen"))).toBe(false);
    expect(readFileSync(script, "utf8")).toBe("Keep this external script\n");
    expect(service.stop).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "refuses a running installed unit even with service.enabled=%s and no PID",
    async (enabled) => {
      editConfig((doc) => {
        doc.setIn(["service", "enabled"], enabled);
      });
      service.status.mockImplementation((context) => Promise.resolve(status(context, true, true)));
      await expect(cmdMigrate(["--yes"])).rejects.toThrow(/Service .* is running/);
      expect(existsSync(join(parent, ".redqueen"))).toBe(false);
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.uninstall).not.toHaveBeenCalled();
    },
  );

  it("rechecks service state and filesystem after asynchronous service inspection", async () => {
    service.status.mockImplementationOnce((context) => Promise.resolve(status(context)));
    service.status.mockImplementationOnce((context) => {
      writeFileSync(join(parent, ".env"), "Created during service inspection");
      return Promise.resolve(status(context));
    });
    await expect(cmdMigrate(["--yes"])).rejects.toThrow(/already exists/);
    expect(existsSync(join(install, "redqueen.yaml"))).toBe(true);
    expect(service.stop).not.toHaveBeenCalled();
  });

  it("prints usable reverse worktree commands after late service failure and old-root cleanup", async () => {
    editConfig((doc) => {
      doc.setIn(["service", "enabled"], true);
    });
    service.status.mockImplementation((context) => Promise.resolve(status(context, true)));
    service.install.mockRejectedValue(new Error("Injected service failure"));
    let message = "";
    try {
      await cmdMigrate(["--yes"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("service reinstall");
    expect(existsSync(stateRoot)).toBe(false);
    for (const line of message
      .split("\n")
      .filter((line) => line.startsWith("  mkdir ") || line.startsWith("  git "))) {
      execFileSync("/bin/sh", ["-c", line], { stdio: "pipe" });
    }
    expect(readFileSync(join(stateRoot, "worktrees", "PROJ-1", "draft.txt"), "utf8")).toBe(
      "Untracked work\n",
    );
  });
});
