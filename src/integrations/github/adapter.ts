import { z } from "zod";
import type { Comment, PipelineEvent } from "../../core/types.js";
import { AdapterError } from "../http/retry.js";
import type {
  CheckConclusion,
  CheckStatus,
  CreatePROptions,
  PullRequest,
  SourceControl,
} from "../source-control.js";
import type { GitHubAuthStrategy, GitHubIdentity } from "./auth.js";
import type { GitHubClient } from "./client.js";
import { parseGitHubWebhookEvent, validateGitHubWebhook } from "./webhook.js";

export const GitHubSourceControlConfigSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  auth: z
    .object({
      type: z.literal("pat"),
      token: z.string().min(1),
    })
    .optional(),
  webhookSecret: z.string().optional(),
});

export type GitHubSourceControlConfig = z.infer<typeof GitHubSourceControlConfigSchema>;

export interface GitHubSourceControlAdapterOptions {
  client: GitHubClient;
  owner: string;
  repo: string;
  webhookSecret: string | null;
  resolveIssueIdFromBranch?: (branch: string) => string | null;
}

interface OctokitRestError extends Error {
  status?: number;
}

export class GitHubSourceControlAdapter implements SourceControl {
  private readonly client: GitHubClient;
  private readonly owner: string;
  private readonly repo: string;
  private readonly webhookSecret: string | null;
  private readonly resolveIssueIdFromBranch: ((branch: string) => string | null) | undefined;
  private identityPromise: Promise<GitHubIdentity> | null = null;
  private identityCached: GitHubIdentity | null = null;

  constructor(options: GitHubSourceControlAdapterOptions) {
    this.client = options.client;
    this.owner = options.owner;
    this.repo = options.repo;
    this.webhookSecret = options.webhookSecret;
    this.resolveIssueIdFromBranch = options.resolveIssueIdFromBranch;
  }

  get auth(): GitHubAuthStrategy {
    return this.client.auth;
  }

  async createBranch(name: string, from: string): Promise<void> {
    const sha = await this.resolveSha(from);
    await this.client.call(`POST /repos/${this.owner}/${this.repo}/git/refs`, () =>
      this.client.rest.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${name}`,
        sha,
      }),
    );
  }

  async deleteBranch(name: string): Promise<void> {
    try {
      await this.client.call(
        `DELETE /repos/${this.owner}/${this.repo}/git/refs/heads/${name}`,
        () =>
          this.client.rest.git.deleteRef({
            owner: this.owner,
            repo: this.repo,
            ref: `heads/${name}`,
          }),
      );
    } catch (err) {
      if (isNotFound(err)) {
        return;
      }
      throw err;
    }
  }

  async branchExists(name: string): Promise<boolean> {
    try {
      await this.client.call(`GET /repos/${this.owner}/${this.repo}/branches/${name}`, () =>
        this.client.rest.repos.getBranch({
          owner: this.owner,
          repo: this.repo,
          branch: name,
        }),
      );
      return true;
    } catch (err) {
      if (isNotFound(err)) {
        return false;
      }
      throw err;
    }
  }

  async createPullRequest(options: CreatePROptions): Promise<PullRequest> {
    const response = await this.client.call(`POST /repos/${this.owner}/${this.repo}/pulls`, () =>
      this.client.rest.pulls.create({
        owner: this.owner,
        repo: this.repo,
        title: options.title,
        body: options.body,
        head: options.head,
        base: options.base,
        draft: options.draft,
      }),
    );
    return toPullRequest(response.data);
  }

  async getPullRequest(prNumber: number): Promise<PullRequest | null> {
    try {
      const response = await this.client.call(
        `GET /repos/${this.owner}/${this.repo}/pulls/${String(prNumber)}`,
        () =>
          this.client.rest.pulls.get({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
          }),
      );
      return toPullRequest(response.data);
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  async getPullRequestDiff(prNumber: number): Promise<string> {
    const response = await this.client.call(
      `GET /repos/${this.owner}/${this.repo}/pulls/${String(prNumber)}.diff`,
      () =>
        this.client.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          mediaType: { format: "diff" },
        }),
    );
    return typeof response.data === "string" ? response.data : JSON.stringify(response.data);
  }

  async mergePullRequest(prNumber: number): Promise<void> {
    await this.client.call(
      `PUT /repos/${this.owner}/${this.repo}/pulls/${String(prNumber)}/merge`,
      () =>
        this.client.rest.pulls.merge({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          merge_method: "squash",
        }),
    );
  }

  async postReview(
    prNumber: number,
    body: string,
    verdict: "approve" | "request-changes",
  ): Promise<void> {
    const event = verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES";
    await this.client.call(
      `POST /repos/${this.owner}/${this.repo}/pulls/${String(prNumber)}/reviews`,
      () =>
        this.client.rest.pulls.createReview({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          body,
          event,
        }),
    );
  }

  async dismissStaleReviews(prNumber: number): Promise<void> {
    const identity = await this.identity();
    const reviews = (await this.client.paginate(this.client.rest.pulls.listReviews, {
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      per_page: 100,
    })) as {
      id: number;
      state: string;
      user: { login?: string } | null;
    }[];
    for (const review of reviews) {
      if (review.state !== "CHANGES_REQUESTED") {
        continue;
      }
      if (review.user?.login !== identity.login) {
        continue;
      }
      try {
        await this.client.call(
          `PUT /repos/${this.owner}/${this.repo}/pulls/${String(prNumber)}/reviews/${String(review.id)}/dismissals`,
          () =>
            this.client.rest.pulls.dismissReview({
              owner: this.owner,
              repo: this.repo,
              pull_number: prNumber,
              review_id: review.id,
              message: "Dismissed by Red Queen on re-review.",
            }),
        );
      } catch (err) {
        const status = (err as OctokitRestError).status;
        if (status === 422) {
          continue;
        }
        throw err;
      }
    }
  }

  async getReviewComments(prNumber: number): Promise<Comment[]> {
    const items = (await this.client.paginate(this.client.rest.pulls.listReviewComments, {
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      per_page: 100,
    })) as {
      id: number;
      user: { login?: string } | null;
      body?: string;
      created_at?: string;
    }[];
    return items.map((c) => ({
      id: String(c.id),
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      createdAt: c.created_at ?? "",
    }));
  }

  async replyToComment(prNumber: number, commentId: number, body: string): Promise<void> {
    await this.client.call(
      `POST /repos/${this.owner}/${this.repo}/pulls/${String(prNumber)}/comments/${String(commentId)}/replies`,
      () =>
        this.client.rest.pulls.createReplyForReviewComment({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          comment_id: commentId,
          body,
        }),
    );
  }

  async getChecks(prNumber: number): Promise<CheckStatus[]> {
    const pr = await this.getPullRequest(prNumber);
    if (pr === null) {
      return [];
    }
    const prDetail = await this.client.call(
      `GET /repos/${this.owner}/${this.repo}/pulls/${String(prNumber)}`,
      () =>
        this.client.rest.pulls.get({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
        }),
    );
    const sha = prDetail.data.head.sha;
    const runs = (await this.client.paginate(this.client.rest.checks.listForRef, {
      owner: this.owner,
      repo: this.repo,
      ref: sha,
      per_page: 100,
    })) as {
      name: string;
      conclusion: string | null;
      html_url: string | null;
    }[];
    return runs.map((r) => ({
      name: r.name,
      conclusion: toConclusion(r.conclusion),
      url: r.html_url,
    }));
  }

  validateWebhook(headers: Record<string, string>, body: string): boolean {
    return validateGitHubWebhook(this.webhookSecret, headers, body);
  }

  parseWebhookEvent(headers: Record<string, string>, body: string): PipelineEvent | null {
    if (this.identityCached === null) {
      return null;
    }
    return parseGitHubWebhookEvent(
      {
        identity: this.identityCached,
        resolveIssueIdFromBranch: this.resolveIssueIdFromBranch,
      },
      headers,
      body,
    );
  }

  validateConfig(config: Record<string, unknown>): void {
    GitHubSourceControlConfigSchema.parse(config);
  }

  async identity(): Promise<GitHubIdentity> {
    if (this.identityCached !== null) {
      return this.identityCached;
    }
    this.identityPromise ??= this.auth.getIdentity().then(
      (id) => {
        this.identityCached = id;
        return id;
      },
      (err: unknown) => {
        this.identityPromise = null;
        throw err;
      },
    );
    return this.identityPromise;
  }

  /**
   * Pre-fetches identity so parseWebhookEvent (synchronous) has a value on
   * subsequent calls. Called during adapter wiring.
   */
  async warmIdentity(): Promise<GitHubIdentity> {
    return this.identity();
  }

  private async resolveSha(ref: string): Promise<string> {
    const target = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
    try {
      const response = await this.client.call(
        `GET /repos/${this.owner}/${this.repo}/branches/${target}`,
        () =>
          this.client.rest.repos.getBranch({
            owner: this.owner,
            repo: this.repo,
            branch: target,
          }),
      );
      return response.data.commit.sha;
    } catch (err) {
      throw new AdapterError(
        `GitHub: could not resolve branch '${target}': ${(err as Error).message}`,
      );
    }
  }
}

interface PullRequestRaw {
  number: number;
  title: string;
  state: string;
  head: { ref: string };
  base: { ref: string };
  html_url: string;
  mergeable_state?: string | null;
  merged?: boolean;
}

function toPullRequest(raw: PullRequestRaw): PullRequest {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    headBranch: raw.head.ref,
    baseBranch: raw.base.ref,
    url: raw.html_url,
    reviewDecision: null,
  };
}

function isNotFound(err: unknown): boolean {
  const status = (err as OctokitRestError).status;
  return status === 404;
}

function toConclusion(value: string | null): CheckConclusion | null {
  if (value === null) {
    return null;
  }
  switch (value) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "action_required":
    case "cancelled":
      return "failure";
    case "skipped":
      return "skipped";
    case "neutral":
      return "neutral";
    default:
      return null;
  }
}
