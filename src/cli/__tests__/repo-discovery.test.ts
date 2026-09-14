import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveRepoEntry,
  detectDefaultBranch,
  discoverRepoChildren,
  isGitWorkTreeRoot,
  listRegisteredWorktrees,
  readGitRemote,
} from "../repo-discovery.js";

const { ghLookup } = vi.hoisted(() => ({ ghLookup: vi.fn<() => string>() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync(...args: Parameters<typeof actual.execFileSync>) {
      return args[0] === "gh" ? ghLookup() : actual.execFileSync(...args);
    },
  };
});

let tmp: string;

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
}

function gitInit(dir: string, remote?: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  if (remote !== undefined) {
    git(dir, ["remote", "add", "origin", remote]);
    git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  }
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "rq-discover-")));
  ghLookup.mockReset();
  ghLookup.mockImplementation(() => {
    throw new Error("gh unavailable");
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("discoverRepoChildren", () => {
  it("lists only visible direct git roots in directory-name order", () => {
    gitInit(join(tmp, "Zeta"), "git@github.com:acme/Zeta.git");
    gitInit(join(tmp, "alpha"));
    gitInit(join(tmp, ".hidden"));
    gitInit(join(tmp, "plain", "nested"));
    writeFileSync(join(tmp, "file"), "not a directory");
    symlinkSync(join(tmp, "absent"), join(tmp, "broken"));

    expect(discoverRepoChildren(tmp)).toEqual([
      { dirName: "Zeta", path: join(tmp, "Zeta"), remote: "git@github.com:acme/Zeta.git" },
      { dirName: "alpha", path: join(tmp, "alpha"), remote: null },
    ]);
  });

  it("does not discover ordinary subdirectories of a parent git repository", () => {
    gitInit(tmp);
    mkdirSync(join(tmp, "src"));
    gitInit(join(tmp, "child"));
    expect(discoverRepoChildren(tmp).map((repo) => repo.dirName)).toEqual(["child"]);
  });

  it("recognizes registered linked worktrees whose .git entry is a file", () => {
    const repo = join(tmp, "repo");
    const worktree = join(tmp, "linked");
    gitInit(repo, "git@github.com:acme/repo.git");
    git(repo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ]);
    git(repo, ["worktree", "add", "--detach", worktree]);

    expect(isGitWorkTreeRoot(worktree)).toBe(true);
    expect(discoverRepoChildren(tmp).map((entry) => entry.dirName)).toEqual(["linked", "repo"]);
    expect(readGitRemote(worktree)).toBe("git@github.com:acme/repo.git");
  });
});

describe("isGitWorkTreeRoot", () => {
  it("accepts symlink aliases of the root but rejects nested, missing, and bare paths", () => {
    const repo = join(tmp, "repo");
    gitInit(repo);
    mkdirSync(join(repo, "nested"));
    symlinkSync(repo, join(tmp, "alias"));
    mkdirSync(join(tmp, "bare"));
    git(join(tmp, "bare"), ["init", "--bare", "-q"]);

    expect(isGitWorkTreeRoot(repo)).toBe(true);
    expect(isGitWorkTreeRoot(join(tmp, "alias"))).toBe(true);
    expect(isGitWorkTreeRoot(join(repo, "nested"))).toBe(false);
    expect(isGitWorkTreeRoot(join(tmp, "missing"))).toBe(false);
    expect(isGitWorkTreeRoot(join(tmp, "bare"))).toBe(false);
  });
});

describe("git metadata", () => {
  it("reads the origin default branch without depending on the checkout branch", () => {
    gitInit(tmp, "https://github.com/acme/repo.git");
    git(tmp, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
    expect(detectDefaultBranch(tmp)).toBe("origin/develop");
    expect(ghLookup).not.toHaveBeenCalled();
  });

  it("returns null for missing origin and unavailable branch metadata", () => {
    gitInit(tmp);
    expect(readGitRemote(tmp)).toBeNull();
    expect(detectDefaultBranch(tmp)).toBeNull();
    expect(ghLookup).not.toHaveBeenCalled();
  });

  it("uses gh when local origin/HEAD is missing and returns null for empty responses", () => {
    gitInit(tmp, "https://github.com/acme/repo.git");
    git(tmp, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    ghLookup.mockReturnValueOnce("stable\n").mockReturnValueOnce("");
    expect(detectDefaultBranch(tmp)).toBe("origin/stable");
    expect(detectDefaultBranch(tmp)).toBeNull();
    expect(ghLookup).toHaveBeenCalledTimes(2);
  });
});

describe("deriveRepoEntry", () => {
  it("derives identity, language, commands, branch, and a relative path with spaces", () => {
    const dir = join(tmp, "Email Templates");
    gitInit(dir, "https://github.com/acme/Email_Templates.git");
    writeFileSync(join(dir, "package.json"), '{"scripts":{"build":"x","test":"y"}}');
    const { entry, languages, primary } = deriveRepoEntry(dir, tmp);

    expect(entry).toEqual({
      name: "email-templates",
      path: "./Email Templates",
      owner: "acme",
      repo: "Email_Templates",
      baseBranch: "origin/main",
      buildCommand: "npm run build",
      testCommand: "npm test",
      modules: [],
    });
    expect(primary).toBe("node-ts");
    expect(languages).toEqual([
      { key: "node-ts", displayName: "Node.js", markerFile: "package.json" },
    ]);
  });

  it("uses non-Node commands, upstream branch, and parent-relative paths", () => {
    const dir = join(tmp, "rust");
    gitInit(dir, "ssh://git@github.com/acme/Rust.git");
    git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
    writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "demo"\n');

    expect(deriveRepoEntry(dir, join(tmp, "workspace")).entry).toMatchObject({
      path: "../rust",
      baseBranch: "origin/trunk",
      buildCommand: "cargo build",
      testCommand: "cargo test",
    });
    expect(deriveRepoEntry(dir, dir).entry.path).toBe("./");
  });

  it("falls back when branch discovery is unavailable", () => {
    gitInit(tmp, "git@github.com:acme/repo.git");
    git(tmp, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    expect(deriveRepoEntry(tmp, tmp).entry.baseBranch).toBe("origin/main");
    expect(ghLookup).toHaveBeenCalledOnce();
  });

  it("rejects non-roots, missing origins, and unparseable origins", () => {
    gitInit(tmp);
    mkdirSync(join(tmp, "src"));
    expect(() => deriveRepoEntry(join(tmp, "src"), tmp)).toThrow(/not a git work tree root/);
    expect(() => deriveRepoEntry(tmp, tmp)).toThrow(/no 'origin' remote/);
    git(tmp, ["remote", "add", "origin", "/local/repository"]);
    expect(() => deriveRepoEntry(tmp, tmp)).toThrow(/origin.*owner\/repo/);
  });
});

describe("listRegisteredWorktrees compatibility", () => {
  function fixture(name = "Worktree spaces_%' "): string {
    gitInit(tmp);
    git(tmp, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ]);
    const path = join(tmp, name);
    git(tmp, ["worktree", "add", "--detach", path]);
    return path;
  }

  function legacyGit(version: string, output?: string) {
    return vi.fn((args: string[], cwd: string): string => {
      if (args[0] === "--version") {
        return `git version ${version}\n`;
      }
      if (args[0] === "worktree" && args[1] === "list") {
        expect(args).toEqual(["worktree", "list", "--porcelain"]);
        // Current Git can quote line output; converting its NUL output gives
        // the literal-path format actually emitted by Git 2.17–2.35.
        const plain = execFileSync("git", [...args, "-z"], {
          cwd,
          encoding: "utf8",
          stdio: "pipe",
        }).replaceAll("\0", "\n");
        return (
          output ?? (version.startsWith("2.17") ? plain.replace(/^locked[^\n]*\n/gm, "") : plain)
        );
      }
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    });
  }

  it.each(["2.17.0", "2.35.8"])(
    "lists ordinary paths including spaces and punctuation on Git %s",
    (version) => {
      const path = fixture();
      expect(listRegisteredWorktrees(tmp, legacyGit(version))).toEqual([
        { path: tmp, locked: false },
        { path, locked: false },
      ]);
    },
  );

  it("retains lock protection on Git 2.17 even though porcelain omits lock annotations", () => {
    const path = fixture();
    git(tmp, ["worktree", "lock", "--reason", "keep this work", path]);
    expect(listRegisteredWorktrees(tmp, legacyGit("2.17.0"))[1]).toEqual({ path, locked: true });
  });

  it("uses NUL output on Git 2.36 and preserves newline paths and multiline lock reasons", () => {
    const path = fixture("worktree\nwith newline");
    git(tmp, ["worktree", "lock", "--reason", "first line\nsecond line", path]);
    const runGit = vi.fn((args: string[], cwd: string): string => {
      if (args[0] === "--version") {
        return "git version 2.36.0\n";
      }
      expect(args).toEqual(["worktree", "list", "--porcelain", "-z"]);
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    });
    expect(listRegisteredWorktrees(tmp, runGit)[1]).toEqual({ path, locked: true });
  });

  it.each(["worktree\nwith newline", "worktree\twith tab"])(
    "refuses unsafe legacy path metadata for %j before trusting line output",
    (name) => {
      fixture(name);
      const runGit = legacyGit("2.17.0");
      expect(() => listRegisteredWorktrees(tmp, runGit)).toThrow(/unsafe registered worktree path/);
      expect(runGit.mock.calls.some(([args]) => args[0] === "worktree")).toBe(false);
    },
  );

  it("refuses an ambiguous multiline lock reason on older Git", () => {
    const path = fixture();
    git(tmp, ["worktree", "lock", "--reason", "reason\n\nworktree /pretend", path]);
    expect(() => listRegisteredWorktrees(tmp, legacyGit("2.35.0"))).toThrow(
      /lock reason containing control/,
    );
  });

  it.each([
    "worktree /pretend\nHEAD invalid\n\n",
    `worktree /pretend\nHEAD ${"a".repeat(40)}\ndetached\nlocked first line\nsecond line\n\n`,
    `worktree "/quoted\\npath"\nHEAD ${"a".repeat(40)}\ndetached\n\n`,
    `worktree /pretend\nHEAD ${"a".repeat(40)}\ndetached\n\n`,
  ])("refuses malformed or metadata-mismatched legacy output", (output) => {
    fixture();
    expect(() => listRegisteredWorktrees(tmp, legacyGit("2.35.0", output))).toThrow(
      /Cannot safely read Git worktree metadata/,
    );
  });
});
