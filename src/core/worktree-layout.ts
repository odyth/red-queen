import { join } from "node:path";
import type { RedQueenConfig, RepoConfig } from "./config.js";

export type WorktreeKind = "coding" | "spec" | "refresh";

export function worktreePathFor(
  config: RedQueenConfig,
  issueId: string,
  repoName: string,
  kind: WorktreeKind = "coding",
): string {
  repoConfigOf(config, repoName);
  const dirName = kind === "coding" ? issueId : `${kind}-${issueId}`;
  const ticketDir = join(config.project.directory, ".redqueen", "worktrees", dirName);
  return config.project.workspaceMode ? join(ticketDir, repoName) : ticketDir;
}

export function repoConfigOf(config: RedQueenConfig, repoName: string): RepoConfig {
  const repo = config.project.repos.find((entry) => entry.name === repoName);
  if (repo === undefined) {
    const valid = config.project.repos.map((entry) => entry.name).join(", ");
    throw new Error(`Unknown repo "${repoName}" — valid repos: ${valid}`);
  }
  return repo;
}

// The workspace root need not be a git repository. Repository operations use
// this path; operations on a checked-out worktree use that repo's worktree.
export function gitCwdFor(config: RedQueenConfig, repoName: string): string {
  return repoConfigOf(config, repoName).path;
}
