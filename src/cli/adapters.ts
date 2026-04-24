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

/**
 * Builds both adapters together, sharing one GitHub client when both are GitHub.
 */
export function buildAdapterPair(input: BuildAdaptersInput): AdapterPair {
  // Both GitHub: share one client + strategy.
  if (input.issueTrackerType === "github-issues" && input.sourceControlType === "github") {
    const githubIssues = GitHubIssuesConfigSchema.parse(input.issueTrackerConfig);
    const githubSc = GitHubSourceControlConfigSchema.parse(input.sourceControlConfig);
    if (githubIssues.owner !== githubSc.owner || githubIssues.repo !== githubSc.repo) {
      throw new CliError(
        "github-issues and github source control must use the same owner/repo — they're paired.",
      );
    }
    const issuesAuth = githubIssues.auth;
    const scAuth = githubSc.auth;
    const token = scAuth?.token ?? issuesAuth?.token;
    if (token === undefined) {
      throw new CliError(
        "GitHub adapter missing auth.token — add ${GITHUB_PAT} to redqueen.yaml and set GITHUB_PAT in .env",
      );
    }
    if (issuesAuth !== undefined && scAuth !== undefined && issuesAuth.token !== scAuth.token) {
      throw new CliError(
        "github-issues and github adapters have divergent auth tokens — they must match.",
      );
    }
    const strategy: GitHubAuthStrategy = new PatAuthStrategy({ token });
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

  const issueTracker = constructIssueTracker(input.issueTrackerType, input.issueTrackerConfig);
  const sourceControl = constructSourceControl(input.sourceControlType, input.sourceControlConfig);

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

export function constructIssueTracker(type: string, config: Record<string, unknown>): IssueTracker {
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
    const token = parsed.auth?.token;
    if (token === undefined) {
      throw new CliError(
        "github-issues adapter requires auth.token — add ${GITHUB_PAT} to redqueen.yaml",
      );
    }
    const strategy = new PatAuthStrategy({ token });
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
): SourceControl {
  if (type === "mock") {
    return new MockSourceControlAdapter();
  }
  if (type === "github") {
    const parsed = GitHubSourceControlConfigSchema.parse(config);
    const token = parsed.auth?.token;
    if (token === undefined) {
      throw new CliError(
        "github sourceControl requires auth.token — add ${GITHUB_PAT} to redqueen.yaml",
      );
    }
    const strategy = new PatAuthStrategy({ token });
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
