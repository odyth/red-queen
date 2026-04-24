import type { Attachment, Issue, IssueTracker } from "../integrations/issue-tracker.js";
import type {
  CheckStatus,
  CreatePROptions,
  PullRequest,
  SourceControl,
} from "../integrations/source-control.js";
import type { Comment, PipelineEvent, ValidationResult } from "../core/types.js";

export class MockIssueTrackerAdapter implements IssueTracker {
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
  listAttachments(): Promise<Attachment[]> {
    return Promise.resolve([]);
  }
  downloadAttachment(): Promise<void> {
    return Promise.resolve();
  }
  transitionTo(): Promise<void> {
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
  postReview(): Promise<void> {
    return Promise.resolve();
  }
  dismissStaleReviews(): Promise<void> {
    return Promise.resolve();
  }
  getReviewComments(): Promise<Comment[]> {
    return Promise.resolve([]);
  }
  replyToComment(): Promise<void> {
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
