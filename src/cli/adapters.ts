import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { RepoConfig } from "../core/config.js";
import type { IssueTracker } from "../integrations/issue-tracker.js";
import {
  GitHubIssuesAdapter,
  GitHubIssuesConfigSchema,
} from "../integrations/github-issues/adapter.js";
import type { GitHubAuthConfig } from "../integrations/github/auth/config.js";
import { ByoAppAuthStrategy } from "../integrations/github/auth/byo-app-strategy.js";
import { PatAuthStrategy } from "../integrations/github/auth/pat-strategy.js";
import { GitHubClient } from "../integrations/github/client.js";
import type { GitHubAuthStrategy } from "../integrations/github/auth.js";
import { JiraIssueTrackerAdapter, JiraConfigSchema } from "../integrations/jira/adapter.js";
import { JiraClient } from "../integrations/jira/client.js";
import { CliError } from "./errors.js";
import { MockIssueTrackerAdapter, MockSourceControlAdapter } from "./mock-adapter.js";
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

export interface BuildAdaptersOptions {
  /** Base directory for resolving relative paths (e.g. `auth.privateKeyPath`). */
  configDir?: string;
  audit?: (message: string, metadata: Record<string, unknown>) => void;
}

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
    validateAppOwners(effectiveAuth, [
      githubIssues.owner,
      ...input.repos.map((repo) => repo.owner),
    ]);
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
    validateAppOwners(
      parsed.auth,
      repos.map((repo) => repo.owner),
    );
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

function validateAppOwners(auth: GitHubAuthConfig | undefined, owners: string[]): void {
  if (auth?.type === "byo-app" && new Set(owners.map((owner) => owner.toLowerCase())).size > 1) {
    throw new CliError(
      `GitHub byo-app auth requires the same owner for project.repos[] and the paired tracker; configured owners: ${[...new Set(owners)].join(", ")}`,
    );
  }
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

export function constructIssueTracker(
  type: string,
  config: Record<string, unknown>,
  options: BuildAdaptersOptions = {},
): IssueTracker {
  if (type === "mock") {
    return new MockIssueTrackerAdapter();
  }
  if (type === "jira") {
    const parsed = JiraConfigSchema.parse(config);
    const client = new JiraClient({
      baseUrl: parsed.baseUrl,
      email: parsed.email,
      apiToken: parsed.apiToken,
    });
    return new JiraIssueTrackerAdapter({ client, config: parsed });
  }
  if (type === "github-issues") {
    const parsed = GitHubIssuesConfigSchema.parse(config);
    const strategy = buildAuthStrategy(parsed.auth, options.configDir);
    const client = new GitHubClient({ auth: strategy });
    return new GitHubIssuesAdapter({
      client,
      owner: parsed.owner,
      repo: parsed.repo,
      webhookSecret: parsed.webhookSecret ?? null,
      audit: options.audit,
    });
  }
  throw new CliError(`Unknown issueTracker type: ${type}`);
}

function buildAuthStrategy(
  auth: GitHubAuthConfig | undefined,
  configDir: string | undefined,
): GitHubAuthStrategy {
  if (auth === undefined) {
    throw new CliError(
      "GitHub adapter missing auth — add `auth: { type: pat, token: ${GITHUB_PAT} }` or `auth: { type: byo-app, ... }` to redqueen.yaml",
    );
  }
  if (auth.type === "pat") {
    return new PatAuthStrategy({ token: auth.token });
  }
  // byo-app
  const pem = readPrivateKeyPem(auth.privateKeyPath, configDir);
  return new ByoAppAuthStrategy({
    appId: auth.appId,
    installationId: auth.installationId,
    privateKeyPem: pem,
  });
}

function readPrivateKeyPem(path: string, configDir: string | undefined): string {
  const resolvedPath = isAbsolute(path) ? path : resolve(configDir ?? process.cwd(), path);
  try {
    return readFileSync(resolvedPath, "utf8");
  } catch (err) {
    throw new CliError(
      `GitHub App private key not readable at ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function pickPairedAuth(
  issuesAuth: GitHubAuthConfig | undefined,
  scAuth: GitHubAuthConfig | undefined,
): GitHubAuthConfig {
  const effective = scAuth ?? issuesAuth;
  if (effective === undefined) {
    throw new CliError(
      "GitHub adapter missing auth — add `auth: { type: pat, token: ${GITHUB_PAT} }` or `auth: { type: byo-app, ... }` to redqueen.yaml",
    );
  }
  if (
    issuesAuth !== undefined &&
    scAuth !== undefined &&
    authsMatch(issuesAuth, scAuth) === false
  ) {
    throw new CliError(
      "github-issues and github adapters have divergent auth config — they must match.",
    );
  }
  return effective;
}

function authsMatch(a: GitHubAuthConfig, b: GitHubAuthConfig): boolean {
  if (a.type !== b.type) {
    return false;
  }
  if (a.type === "pat" && b.type === "pat") {
    return a.token === b.token;
  }
  if (a.type === "byo-app" && b.type === "byo-app") {
    return (
      a.appId === b.appId &&
      a.installationId === b.installationId &&
      a.privateKeyPath === b.privateKeyPath
    );
  }
  return false;
}
