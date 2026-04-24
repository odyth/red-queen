import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { IssueTracker } from "../integrations/issue-tracker.js";
import type { SourceControl } from "../integrations/source-control.js";
import {
  GitHubIssuesAdapter,
  GitHubIssuesConfigSchema,
} from "../integrations/github-issues/adapter.js";
import {
  GitHubSourceControlAdapter,
  GitHubSourceControlConfigSchema,
} from "../integrations/github/adapter.js";
import type { GitHubAuthConfig } from "../integrations/github/auth/config.js";
import { ByoAppAuthStrategy } from "../integrations/github/auth/byo-app-strategy.js";
import { PatAuthStrategy } from "../integrations/github/auth/pat-strategy.js";
import { GitHubClient } from "../integrations/github/client.js";
import type { GitHubAuthStrategy } from "../integrations/github/auth.js";
import { JiraIssueTrackerAdapter, JiraConfigSchema } from "../integrations/jira/adapter.js";
import { JiraClient } from "../integrations/jira/client.js";
import { CliError } from "./errors.js";
import { MockIssueTrackerAdapter, MockSourceControlAdapter } from "./mock-adapter.js";

export interface AdapterPair {
  issueTracker: IssueTracker;
  sourceControl: SourceControl;
  warmup: () => Promise<void>;
}

export interface BuildAdaptersInput {
  issueTrackerType: string;
  issueTrackerConfig: Record<string, unknown>;
  sourceControlType: string;
  sourceControlConfig: Record<string, unknown>;
}

export interface BuildAdaptersOptions {
  /** Base directory for resolving relative paths (e.g. `auth.privateKeyPath`). */
  configDir?: string;
}

/**
 * Builds both adapters together, sharing one GitHub client when both are GitHub.
 */
export function buildAdapterPair(
  input: BuildAdaptersInput,
  options: BuildAdaptersOptions = {},
): AdapterPair {
  // Both GitHub: share one client + strategy.
  if (input.issueTrackerType === "github-issues" && input.sourceControlType === "github") {
    const githubIssues = GitHubIssuesConfigSchema.parse(input.issueTrackerConfig);
    const githubSc = GitHubSourceControlConfigSchema.parse(input.sourceControlConfig);
    if (githubIssues.owner !== githubSc.owner || githubIssues.repo !== githubSc.repo) {
      throw new CliError(
        "github-issues and github source control must use the same owner/repo — they're paired.",
      );
    }
    const effectiveAuth = pickPairedAuth(githubIssues.auth, githubSc.auth);
    const strategy: GitHubAuthStrategy = buildAuthStrategy(effectiveAuth, options.configDir);
    const client = new GitHubClient({ auth: strategy });

    const sourceControl = new GitHubSourceControlAdapter({
      client,
      owner: githubSc.owner,
      repo: githubSc.repo,
      webhookSecret: githubSc.webhookSecret ?? null,
    });
    const issueTracker = new GitHubIssuesAdapter({
      client,
      owner: githubIssues.owner,
      repo: githubIssues.repo,
      webhookSecret: githubIssues.webhookSecret ?? null,
    });
    return {
      issueTracker,
      sourceControl,
      warmup: async () => {
        await Promise.all([sourceControl.warmIdentity(), issueTracker.warmIdentity()]);
      },
    };
  }

  const issueTracker = constructIssueTracker(
    input.issueTrackerType,
    input.issueTrackerConfig,
    options,
  );
  const sourceControl = constructSourceControl(
    input.sourceControlType,
    input.sourceControlConfig,
    options,
  );

  const warmup = async (): Promise<void> => {
    const warmers: Promise<unknown>[] = [];
    if (issueTracker instanceof JiraIssueTrackerAdapter) {
      warmers.push(issueTracker.warmIdentity());
    }
    if (issueTracker instanceof GitHubIssuesAdapter) {
      warmers.push(issueTracker.warmIdentity());
    }
    if (sourceControl instanceof GitHubSourceControlAdapter) {
      warmers.push(sourceControl.warmIdentity());
    }
    await Promise.all(warmers);
  };

  return { issueTracker, sourceControl, warmup };
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
    });
  }
  throw new CliError(`Unknown issueTracker type: ${type}`);
}

export function constructSourceControl(
  type: string,
  config: Record<string, unknown>,
  options: BuildAdaptersOptions = {},
): SourceControl {
  if (type === "mock") {
    return new MockSourceControlAdapter();
  }
  if (type === "github") {
    const parsed = GitHubSourceControlConfigSchema.parse(config);
    const strategy = buildAuthStrategy(parsed.auth, options.configDir);
    const client = new GitHubClient({ auth: strategy });
    return new GitHubSourceControlAdapter({
      client,
      owner: parsed.owner,
      repo: parsed.repo,
      webhookSecret: parsed.webhookSecret ?? null,
    });
  }
  throw new CliError(`Unknown sourceControl type: ${type}`);
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
