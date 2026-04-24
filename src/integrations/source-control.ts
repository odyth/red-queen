import type { Comment, PipelineEvent } from "../core/types.js";

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
  state: string;
  headBranch: string;
  baseBranch: string;
  url: string;
  reviewDecision: string | null;
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

  // Review operations
  postReview(prNumber: number, body: string, verdict: "approve" | "request-changes"): Promise<void>;
  dismissStaleReviews(prNumber: number): Promise<void>;
  getReviewComments(prNumber: number): Promise<Comment[]>;
  replyToComment(prNumber: number, commentId: number, body: string): Promise<void>;

  // CI checks
  getChecks(prNumber: number): Promise<CheckStatus[]>;

  // Webhook handling
  validateWebhook(headers: Record<string, string>, body: string): boolean;
  parseWebhookEvent(headers: Record<string, string>, body: string): PipelineEvent | null;

  // Config validation (throws on invalid config)
  validateConfig(config: Record<string, unknown>): void;
}
