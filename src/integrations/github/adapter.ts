import { z } from "zod";
import type {
  Comment,
  GetReviewThreadsOptions,
  PipelineEvent,
  ReviewThread,
  ReviewThreadComment,
} from "../../core/types.js";
import { AdapterError } from "../http/retry.js";
import type {
  CheckConclusion,
  CheckStatus,
  CreatePROptions,
  PullRequest,
  Review,
  ReviewState,
  SourceControl,
} from "../source-control.js";
import type { GitHubAuthStrategy, GitHubIdentity } from "./auth.js";
import { GitHubAuthConfigSchema } from "./auth/config.js";
import type { GitHubClient } from "./client.js";
import { parseGitHubWebhookEvent, validateGitHubWebhook } from "./webhook.js";

export const GitHubSourceControlConfigSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  auth: GitHubAuthConfigSchema.optional(),
  webhookSecret: z.string().optional(),
});

export type GitHubSourceControlConfig = z.infer<typeof GitHubSourceControlConfigSchema>;

export interface GitHubSourceControlAdapterOptions {
  client: GitHubClient;
  owner: string;
  repo: string;
  webhookSecret: string | null;
  resolveIssueIdFromBranch?: (branch: string) => string | null;
  audit?: (message: string, metadata: Record<string, unknown>) => void;
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
  private readonly audit: (message: string, metadata: Record<string, unknown>) => void;
  private identityPromise: Promise<GitHubIdentity> | null = null;
  private identityCached: GitHubIdentity | null = null;

  constructor(options: GitHubSourceControlAdapterOptions) {
    this.client = options.client;
    this.owner = options.owner;
    this.repo = options.repo;
    this.webhookSecret = options.webhookSecret;
    this.resolveIssueIdFromBranch = options.resolveIssueIdFromBranch;
    this.audit = options.audit ?? ((): void => undefined);
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

  async getReviews(prNumber: number): Promise<Review[]> {
    const reviews = (await this.client.paginate(this.client.rest.pulls.listReviews, {
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      per_page: 100,
    })) as {
      id: number;
      user: { login?: string } | null;
      body?: string;
      state?: string;
      submitted_at?: string | null;
    }[];
    return reviews.map((r) => ({
      id: String(r.id),
      author: r.user?.login ?? "unknown",
      body: r.body ?? "",
      state: toReviewState(r.state),
      submittedAt: r.submitted_at ?? "",
    }));
  }

  async postPrComment(prNumber: number, body: string): Promise<void> {
    await this.client.call(
      `POST /repos/${this.owner}/${this.repo}/issues/${String(prNumber)}/comments`,
      () =>
        this.client.rest.issues.createComment({
          owner: this.owner,
          repo: this.repo,
          issue_number: prNumber,
          body,
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
      user: { login?: string; id?: number } | null;
    }[];
    for (const review of reviews) {
      if (review.state !== "CHANGES_REQUESTED") {
        continue;
      }
      if (review.user?.id === undefined || String(review.user.id) !== identity.accountId) {
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

  async getReviewThreads(
    prNumber: number,
    options?: GetReviewThreadsOptions,
  ): Promise<ReviewThread[]> {
    const unresolvedOnly = options?.unresolvedOnly ?? true;
    const threads: ReviewThread[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.client.call(
        `GraphQL reviewThreads ${this.owner}/${this.repo}#${String(prNumber)}`,
        () =>
          this.client.octokit.graphql<ReviewThreadsPage>(REVIEW_THREADS_QUERY, {
            owner: this.owner,
            repo: this.repo,
            pr: prNumber,
            cursor,
          }),
      );
      const pr = page.repository?.pullRequest;
      if (pr === null || pr === undefined) {
        break;
      }
      for (const node of pr.reviewThreads.nodes) {
        if (unresolvedOnly && node.isResolved) {
          continue;
        }
        const allComments = await this.loadAllThreadComments(prNumber, node);
        threads.push(toReviewThread(node, allComments));
      }
      cursor = pr.reviewThreads.pageInfo.hasNextPage ? pr.reviewThreads.pageInfo.endCursor : null;
    } while (cursor !== null);
    return threads;
  }

  private async loadAllThreadComments(
    prNumber: number,
    node: ReviewThreadNode,
  ): Promise<ReviewThreadCommentNode[]> {
    const all: ReviewThreadCommentNode[] = [...node.comments.nodes];
    if (node.comments.pageInfo.hasNextPage === false) {
      return all;
    }
    this.audit(
      `GitHub review thread has >100 comments — paginating remaining pages (totalCount=${String(node.comments.totalCount)})`,
      {
        pr: prNumber,
        threadId: node.id,
        totalCount: node.comments.totalCount,
      },
    );
    let cursor: string | null = node.comments.pageInfo.endCursor;
    while (cursor !== null) {
      const page: ThreadCommentsPage = await this.client.call(
        `GraphQL threadComments ${this.owner}/${this.repo}#${String(prNumber)} thread=${node.id}`,
        () =>
          this.client.octokit.graphql<ThreadCommentsPage>(THREAD_COMMENTS_QUERY, {
            threadId: node.id,
            cursor,
          }),
      );
      const comments = page.node?.comments;
      if (comments === undefined) {
        break;
      }
      all.push(...comments.nodes);
      cursor = comments.pageInfo.hasNextPage ? comments.pageInfo.endCursor : null;
    }
    return all;
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
      this.audit("GitHub webhook dropped: identity not warmed yet (warmIdentity hasn't resolved)", {
        event: headers["x-github-event"] ?? null,
        delivery: headers["x-github-delivery"] ?? null,
      });
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

function toReviewState(value: string | undefined): ReviewState {
  switch (value) {
    case "APPROVED":
      return "APPROVED";
    case "CHANGES_REQUESTED":
      return "CHANGES_REQUESTED";
    default:
      // COMMENTED, DISMISSED, PENDING and any future state collapse to COMMENTED —
      // the coder reads the body regardless of which non-actionable state it carries.
      return "COMMENTED";
  }
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

const REVIEW_THREADS_QUERY = `
query ReviewThreads($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            totalCount
            nodes {
              databaseId
              author { login }
              body
              createdAt
            }
          }
        }
      }
    }
  }
}`;

// Follow-up query for threads whose comments exceed the first page. Keyed by
// the thread's global node id so we can paginate a single thread independently.
const THREAD_COMMENTS_QUERY = `
query ThreadComments($threadId: ID!, $cursor: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          databaseId
          author { login }
          body
          createdAt
        }
      }
    }
  }
}`;

interface ReviewThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ReviewThreadNode[];
      };
    } | null;
  } | null;
}

interface ReviewThreadCommentNode {
  databaseId: number | null;
  author: { login?: string } | null;
  body: string;
  createdAt: string;
}

interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    totalCount: number;
    nodes: ReviewThreadCommentNode[];
  };
}

interface ThreadCommentsPage {
  node: {
    comments: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ReviewThreadCommentNode[];
    };
  } | null;
}

function toReviewThreadComment(c: ReviewThreadCommentNode): ReviewThreadComment | null {
  if (c.databaseId === null) {
    return null;
  }
  return {
    id: String(c.databaseId),
    author: c.author?.login ?? "unknown",
    body: c.body,
    createdAt: c.createdAt,
  };
}

function toReviewThread(
  node: ReviewThreadNode,
  allComments: ReviewThreadCommentNode[],
): ReviewThread {
  const comments: ReviewThreadComment[] = [];
  for (const raw of allComments) {
    const mapped = toReviewThreadComment(raw);
    if (mapped !== null) {
      comments.push(mapped);
    }
  }
  return {
    threadId: node.id,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    path: node.path,
    line: node.line,
    comments,
  };
}
