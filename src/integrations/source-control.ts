import type {
  Comment,
  GetReviewThreadsOptions,
  PipelineEvent,
  ReviewThread,
} from "../core/types.js";

export interface CreatePROptions {
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  state: "open" | "closed";
  // A merged PR reports state "closed" — only this distinguishes it from one
  // closed without merging.
  merged: boolean;
  headBranch: string;
  baseBranch: string;
  url: string;
  reviewDecision: string | null;
}

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";

export interface Review {
  id: string;
  author: string;
  body: string;
  state: ReviewState;
  submittedAt: string;
}

export type CheckConclusion = "success" | "failure" | "pending" | "skipped" | "neutral";

export interface CheckStatus {
  name: string;
  conclusion: CheckConclusion | null;
  url: string | null;
}

export interface SourceControl {
  // Branch operations
  createBranch(name: string, from: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  branchExists(name: string): Promise<boolean>;

  // PR operations
  createPullRequest(options: CreatePROptions): Promise<PullRequest>;
  getPullRequest(prNumber: number): Promise<PullRequest | null>;
  getPullRequestDiff(prNumber: number): Promise<string>;
  mergePullRequest(prNumber: number): Promise<void>;
  // Retarget an open PR onto a new base branch (stacked dependents after
  // their blocker merges). Idempotent.
  updatePullRequestBase(prNumber: number, base: string): Promise<void>;

  // Review operations
  postReview(prNumber: number, body: string, verdict: "approve" | "request-changes"): Promise<void>;
  getReviews(prNumber: number): Promise<Review[]>;
  dismissStaleReviews(prNumber: number): Promise<void>;
  getReviewComments(prNumber: number): Promise<Comment[]>;
  getReviewThreads(prNumber: number, options?: GetReviewThreadsOptions): Promise<ReviewThread[]>;
  replyToComment(prNumber: number, commentId: number, body: string): Promise<void>;

  // PR-level (issue) comment — distinct from inline review-thread comments.
  postPrComment(prNumber: number, body: string): Promise<void>;

  // CI checks
  getChecks(prNumber: number): Promise<CheckStatus[]>;

  // Webhook handling
  validateWebhook(headers: Record<string, string>, body: string): boolean;
  parseWebhookEvent(headers: Record<string, string>, body: string): PipelineEvent | null;

  // Config validation (throws on invalid config)
  validateConfig(config: Record<string, unknown>): void;
}
