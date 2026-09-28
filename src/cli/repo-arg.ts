import type { RedQueenConfig, RepoConfig } from "../core/config.js";
import type { PipelineStateStore } from "../core/pipeline-state.js";
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

// Workspace scope has one writer, spec meta. A write aimed at any other repo
// would add it to the issue, which then waits on a merge that never comes.
export function resolveScopedRepoArg(
  config: RedQueenConfig,
  pipelineState: PipelineStateStore,
  issueId: string,
  raw: string | undefined,
  cmd: string,
): RepoConfig {
  const repo = resolveRepoArg(config, raw, cmd);
  if (config.project.workspaceMode === false) {
    return repo;
  }
  const rows = pipelineState.listRepos(issueId);
  if (rows.some((row) => row.repo === repo.name && row.inScope)) {
    return repo;
  }
  const scoped = rows.filter((row) => row.inScope).map((row) => row.repo);
  throw new CliError(
    scoped.length === 0
      ? `${cmd}: repo "${repo.name}" is not in scope for ${issueId} — no scope is recorded; run spec meta ${issueId} --repos <names> first`
      : `${cmd}: repo "${repo.name}" is not in scope for ${issueId} (in scope: ${scoped.join(", ")})`,
  );
}
