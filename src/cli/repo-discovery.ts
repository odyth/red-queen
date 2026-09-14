import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export interface IRegisteredWorktree {
  path: string;
  locked: boolean;
}

function worktreeGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function unsafePorcelain(message: string): never {
  throw new CliError(
    `Cannot safely read Git worktree metadata: ${message}. Repair ambiguous paths/lock reasons, or use Git >= 2.36 for NUL-delimited worktree output. No files have changed.`,
  );
}

function hasControlCharacters(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function parseWorktreePorcelain(output: string, nul: boolean): IRegisteredWorktree[] {
  const delimiter = nul ? "\0" : "\n";
  const separator = delimiter.repeat(2);
  if (output.endsWith(separator) === false) {
    unsafePorcelain("incomplete worktree listing");
  }
  const paths = new Set<string>();
  return output
    .slice(0, -separator.length)
    .split(separator)
    .map((record) => {
      const fields = record.split(delimiter);
      const path = fields.shift()?.slice("worktree ".length);
      if (
        record.startsWith("worktree ") === false ||
        path === undefined ||
        isAbsolute(path) === false ||
        (nul === false && hasControlCharacters(path)) ||
        paths.has(path)
      ) {
        unsafePorcelain("an invalid, duplicate, or ambiguous worktree path");
      }
      paths.add(path);
      const head = fields.shift();
      if (head !== "bare") {
        if (head === undefined || /^HEAD (?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) === false) {
          unsafePorcelain("an invalid HEAD record (possibly a newline in a path)");
        }
        const branch = fields[0];
        if (
          branch === "detached" ||
          (branch !== undefined && /^branch refs\/[^\s]+$/.test(branch))
        ) {
          fields.shift();
        }
      }
      const annotations = new Set<string>();
      for (const field of fields) {
        const key = field.split(" ", 1)[0] ?? "";
        if (
          (key !== "locked" && key !== "prunable") ||
          annotations.has(key) ||
          (nul === false && hasControlCharacters(field))
        ) {
          unsafePorcelain("ambiguous worktree annotations or lock reasons");
        }
        annotations.add(key);
      }
      return { path, locked: annotations.has("locked") };
    });
}

function legacyWorktreeMetadata(dir: string, runGit: typeof worktreeGit): Map<string, boolean> {
  const rawCommon = runGit(["rev-parse", "--git-common-dir"], dir);
  const common = rawCommon.endsWith("\n") ? rawCommon.slice(0, -1) : rawCommon;
  if (common.length === 0 || hasControlCharacters(common)) {
    unsafePorcelain("an unsafe Git common-directory path");
  }
  const metadata = new Map<string, boolean>();
  const root = resolve(dir, common, "worktrees");
  if (existsSync(root) === false) {
    return metadata;
  }
  for (const entry of readdirSync(root)) {
    const registration = join(root, entry);
    const rawPath = readFileSync(join(registration, "gitdir"), "utf8");
    const gitdir = rawPath.endsWith("\n") ? rawPath.slice(0, -1) : rawPath;
    if (
      isAbsolute(gitdir) === false ||
      basename(gitdir) !== ".git" ||
      hasControlCharacters(gitdir)
    ) {
      unsafePorcelain("an unsafe registered worktree path");
    }
    const path = dirname(gitdir);
    if (metadata.has(path)) {
      unsafePorcelain("duplicate worktree registrations");
    }
    const lock = join(registration, "locked");
    const locked = existsSync(lock);
    if (locked) {
      const rawReason = readFileSync(lock, "utf8");
      const reason = rawReason.endsWith("\n") ? rawReason.slice(0, -1) : rawReason;
      if (hasControlCharacters(reason)) {
        unsafePorcelain("a lock reason containing control characters");
      }
    }
    metadata.set(path, locked);
  }
  return metadata;
}

export function listRegisteredWorktrees(
  dir: string,
  runGit: typeof worktreeGit = worktreeGit,
): IRegisteredWorktree[] {
  const version = /^git version (\d+)\.(\d+)/.exec(runGit(["--version"], dir));
  if (version?.[1] === undefined || version[2] === undefined) {
    unsafePorcelain("unrecognized git --version output");
  }
  // NUL-delimited porcelain was introduced in Git 2.36. Older releases print
  // paths literally, so validate metadata before trusting their line framing.
  const nul = Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 36);
  const metadata = nul ? null : legacyWorktreeMetadata(dir, runGit);
  const records = parseWorktreePorcelain(
    runGit(["worktree", "list", "--porcelain", ...(nul ? ["-z"] : [])], dir),
    nul,
  );
  if (metadata !== null) {
    const linked = records.slice(1);
    if (
      linked.length !== metadata.size ||
      linked.some((record) => metadata.has(record.path) === false)
    ) {
      unsafePorcelain("worktree listing does not match Git's registrations");
    }
    // Git 2.17 does not emit locked annotations. The lock files remain the
    // authoritative source, including empty lock reasons.
    for (const record of linked) {
      record.locked = record.locked || metadata.get(record.path) === true;
    }
  }
  return records;
}

export function isGitWorkTreeRoot(dir: string): boolean {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Git reports the canonical root, including for linked worktrees and
    // symlinked parent directories such as /tmp on macOS.
    return realpathSync(top) === realpathSync(dir);
  } catch {
    return false;
  }
}

export function readGitRemote(dir: string): string | null {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return remote.length > 0 ? remote : null;
  } catch {
    return null;
  }
}

export function detectDefaultBranch(dir: string): string | null {
  try {
    const out = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out.startsWith("refs/remotes/")) {
      return out.slice("refs/remotes/".length);
    }
  } catch {
    // A local origin/HEAD is optional; retain init's GitHub CLI fallback.
  }
  if (readGitRemote(dir) === null) {
    return null;
  }
  try {
    const out = execFileSync(
      "gh",
      ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      { cwd: dir, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out.length > 0 ? `origin/${out}` : null;
  } catch {
    // Offline installs and installs without gh use the caller's default.
    return null;
  }
}

export function discoverRepoChildren(rootDir: string): DiscoveredRepo[] {
  const found: DiscoveredRepo[] = [];
  for (const dirName of readdirSync(rootDir).sort()) {
    if (dirName.startsWith(".")) {
      continue;
    }
    const path = resolve(rootDir, dirName);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      // Ignore broken links and children removed during discovery.
      continue;
    }
    if (isDirectory && isGitWorkTreeRoot(path)) {
      found.push({ dirName, path, remote: readGitRemote(path) });
    }
  }
  return found;
}

export interface RepoEntryDerivation {
  entry: RepoConfig;
  languages: LanguageDetection[];
  primary: LanguageKey;
}

export function deriveRepoEntry(repoPath: string, rootDir: string): RepoEntryDerivation {
  if (isGitWorkTreeRoot(repoPath) === false) {
    throw new CliError(`${repoPath} is not a git work tree root`);
  }
  const remote = readGitRemote(repoPath);
  const parsed = remote === null ? null : parseGitRemote(remote);
  if (parsed === null) {
    throw new CliError(
      `${repoPath} has no 'origin' remote (or its URL does not identify owner/repo) — add one so owner/repo can be derived`,
    );
  }
  const languages = detectLanguages(repoPath);
  const primary: LanguageKey = languages[0]?.key ?? "blank";
  const suggested = suggestCommands(primary, repoPath);
  const rel = relative(rootDir, repoPath).split(sep).join("/");
  return {
    entry: {
      name: deriveRepoName(parsed.repo),
      path: rel.startsWith("../") ? rel : `./${rel}`,
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
