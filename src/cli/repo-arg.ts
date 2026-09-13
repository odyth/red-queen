import type { RedQueenConfig, RepoConfig } from "../core/config.js";
import { CliError } from "./errors.js";

// PR numbers collide across repos. Workspace helpers name their repo explicitly;
// legacy installs can continue to omit the flag for their sole repository.
export function resolveRepoArg(
  config: RedQueenConfig,
  raw: string | undefined,
  cmd: string,
): RepoConfig {
  const repos = config.project.repos;
  const valid = repos.map((repo) => repo.name).join(", ");
  if (raw === undefined) {
    const sole = repos[0];
    if (config.project.workspaceMode || sole === undefined) {
      throw new CliError(`${cmd}: --repo <name> is required in workspace mode (valid: ${valid})`);
    }
    return sole;
  }
  const found = repos.find((repo) => repo.name === raw);
  if (found === undefined) {
    throw new CliError(`${cmd}: unknown repo "${raw}" — valid: ${valid}`);
  }
  return found;
}
