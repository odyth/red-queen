import type {
  AiAssignmentState,
  Attachment,
  BlockerRef,
  Issue,
  IssueTracker,
} from "../integrations/issue-tracker.js";
import type {
  CheckStatus,
  CreatePROptions,
  PullRequest,
  Review,
  SourceControl,
} from "../integrations/source-control.js";
import type {
  Comment,
  CostBreakdown,
  PipelineEvent,
  ReviewThread,
  ValidationResult,
} from "../core/types.js";

export class MockIssueTrackerAdapter implements IssueTracker {
  readonly costBreakdowns = new Map<string, CostBreakdown>();

  getIssue(issueId: string): Promise<Issue> {
    return Promise.resolve({
      id: issueId,
      key: issueId,
      summary: `Mock issue ${issueId}`,
      status: "Open",
      phase: null,
      assignee: null,
      reporter: null,
      issueType: "feature",
      labels: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  listIssuesByPhase(): Promise<Issue[]> {
    return Promise.resolve([]);
  }
  listIssuesAssignedToAi(): Promise<Issue[]> {
    return Promise.resolve([]);
  }
  getAiAssignmentState(): Promise<AiAssignmentState> {
    return Promise.resolve({ phase: null, assignedToAi: false });
  }
  getPhase(): Promise<string | null> {
    return Promise.resolve(null);
  }
  setPhase(): Promise<void> {
    return Promise.resolve();
  }
  assignToAi(): Promise<void> {
    return Promise.resolve();
  }
  assignToHuman(): Promise<void> {
    return Promise.resolve();
  }
  getSpec(): Promise<string | null> {
    return Promise.resolve(null);
  }
  setSpec(): Promise<void> {
    return Promise.resolve();
  }
  addComment(): Promise<void> {
    return Promise.resolve();
  }
  getComments(): Promise<Comment[]> {
    return Promise.resolve([]);
  }
  getBlockedBy(): Promise<BlockerRef[]> {
    return Promise.resolve([]);
  }
  setCostBreakdown(issueId: string, breakdown: CostBreakdown): Promise<void> {
    this.costBreakdowns.set(issueId, breakdown);
    return Promise.resolve();
  }
  listAttachments(): Promise<Attachment[]> {
    return Promise.resolve([]);
  }
  downloadAttachment(): Promise<void> {
    return Promise.resolve();
  }
  transitionTo(): Promise<void> {
    return Promise.resolve();
  }
  markInProgress(): Promise<void> {
    return Promise.resolve();
  }
  validateWebhook(): boolean {
    return true;
  }
  parseWebhookEvent(): PipelineEvent | null {
    return null;
  }
  validateConfig(): ValidationResult {
    return { errors: [], warnings: [] };
  }
  validatePhaseMapping(): ValidationResult {
    return { errors: [], warnings: [] };
  }
}

export class MockSourceControlAdapter implements SourceControl {
  private prs = new Map<number, PullRequest>();

  createBranch(): Promise<void> {
    return Promise.resolve();
  }
  deleteBranch(): Promise<void> {
    return Promise.resolve();
  }
  branchExists(): Promise<boolean> {
    return Promise.resolve(false);
  }
  createPullRequest(options: CreatePROptions): Promise<PullRequest> {
    const number = this.prs.size + 1;
    const pr: PullRequest = {
      number,
      title: options.title,
      state: "open",
      merged: false,
      headBranch: options.head,
      baseBranch: options.base,
      url: `mock://pr/${String(number)}`,
      reviewDecision: null,
    };
    this.prs.set(number, pr);
    return Promise.resolve(pr);
  }
  getPullRequest(prNumber: number): Promise<PullRequest | null> {
    return Promise.resolve(this.prs.get(prNumber) ?? null);
  }
  getPullRequestDiff(): Promise<string> {
    return Promise.resolve("");
  }
  mergePullRequest(): Promise<void> {
    return Promise.resolve();
  }
  updatePullRequestBase(prNumber: number, base: string): Promise<void> {
    const pr = this.prs.get(prNumber);
    if (pr !== undefined) {
      pr.baseBranch = base;
    }
    return Promise.resolve();
  }
  postReview(): Promise<void> {
    return Promise.resolve();
  }
  getReviews(): Promise<Review[]> {
    return Promise.resolve([]);
  }
  dismissStaleReviews(): Promise<void> {
    return Promise.resolve();
  }
  getReviewComments(): Promise<Comment[]> {
    return Promise.resolve([]);
  }
  getReviewThreads(): Promise<ReviewThread[]> {
    return Promise.resolve([]);
  }
  replyToComment(): Promise<void> {
    return Promise.resolve();
  }
  postPrComment(): Promise<void> {
    return Promise.resolve();
  }
  getChecks(): Promise<CheckStatus[]> {
    return Promise.resolve([]);
  }
  validateWebhook(): boolean {
    return true;
  }
  parseWebhookEvent(): PipelineEvent | null {
    return null;
  }
  validateConfig(): void {
    // no-op
  }
}
