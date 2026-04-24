import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { globSync } from "node:fs";
import type { ProjectModule } from "./config.js";
import type { ModuleResolver } from "./skill-context.js";
import type { SkillModuleContext } from "./types.js";

export interface ResolveModuleOptions {
  runGit?: (args: string[], cwd: string) => string;
  onGitError?: (message: string) => void;
}

export function createModuleResolver(options: ResolveModuleOptions = {}): ModuleResolver {
  const runGit = options.runGit ?? defaultRunGit;
  const onGitError = options.onGitError ?? defaultOnGitError;

  return (worktreePath, baseBranch, modules) => {
    if (worktreePath === null || worktreePath === "") {
      return null;
    }
    if (existsSync(worktreePath) === false) {
      return null;
    }
    if (modules.length === 0) {
      return null;
    }

    let changedFiles: string[];
    try {
      const out = runGit(["diff", "--name-only", `${baseBranch}...HEAD`], worktreePath);
      changedFiles = out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onGitError(
        `module-resolver: git diff ${baseBranch}...HEAD failed in ${worktreePath} — per-module targeting disabled for this run. Cause: ${msg}`,
      );
      return null;
    }

    if (changedFiles.length === 0) {
      return null;
    }

    for (const mod of modules) {
      if (matchesAny(changedFiles, mod.paths, worktreePath)) {
        return toModuleContext(mod);
      }
    }
    return null;
  };
}

function matchesAny(files: string[], patterns: string[], cwd: string): boolean {
  for (const pattern of patterns) {
    const matches = globSync(pattern, { cwd });
    const matchSet = new Set(matches);
    for (const file of files) {
      if (matchSet.has(file)) {
        return true;
      }
    }
  }
  return false;
}

function toModuleContext(mod: ProjectModule): SkillModuleContext {
  return {
    buildCommand: mod.buildCommand,
    testCommandTargeted: mod.testCommandTargeted,
    testCommandFull: mod.testCommandFull ?? null,
  };
}

function defaultRunGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function defaultOnGitError(message: string): void {
  process.stderr.write(`[warn] ${message}\n`);
}
