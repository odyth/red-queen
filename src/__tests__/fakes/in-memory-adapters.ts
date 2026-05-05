import type { Comment, PipelineEvent, ValidationResult } from "../../core/types.js";
import type { Attachment, Issue, IssueTracker } from "../../integrations/issue-tracker.js";
import type {
  CheckStatus,
  CreatePROptions,
  PullRequest,
  SourceControl,
} from "../../integrations/source-control.js";

export interface InMemoryIssueTrackerSeed {
  issues?: Issue[];
}

export class InMemoryIssueTracker implements IssueTracker {
  readonly issues = new Map<string, Issue>();
  readonly phases = new Map<string, string | null>();
  readonly assignments = new Map<string, "ai" | "human">();
  readonly specs = new Map<string, string>();
  readonly commentsById = new Map<string, Comment[]>();
  readonly labels = new Map<string, Set<string>>();
  readonly calls: string[] = [];
  private commentCounter = 0;

  constructor(seed: InMemoryIssueTrackerSeed = {}) {
    for (const issue of seed.issues ?? []) {
      this.issues.set(issue.id, issue);
      this.phases.set(issue.id, issue.phase);
      this.labels.set(issue.id, new Set(issue.labels));
      if (issue.assignee === "ai-user") {
        this.assignments.set(issue.id, "ai");
      } else if (issue.assignee !== null && issue.assignee !== "") {
        this.assignments.set(issue.id, "human");
      }
    }
  }

  getIssue(issueId: string): Promise<Issue> {
    this.calls.push(`getIssue:${issueId}`);
    const issue = this.issues.get(issueId);
    if (issue === undefined) {
      return Promise.reject(new Error(`Issue ${issueId} not found`));
    }
    return Promise.resolve({ ...issue, phase: this.phases.get(issueId) ?? issue.phase });
  }

  listIssuesByPhase(phaseName: string): Promise<Issue[]> {
    this.calls.push(`listIssuesByPhase:${phaseName}`);
    const results: Issue[] = [];
    for (const [issueId, phase] of this.phases) {
      if (phase !== phaseName) {
        continue;
      }
      const issue = this.issues.get(issueId);
      if (issue !== undefined) {
        results.push({ ...issue, phase });
      }
    }
    return Promise.resolve(results);
  }

  getPhase(issueId: string): Promise<string | null> {
    this.calls.push(`getPhase:${issueId}`);
    return Promise.resolve(this.phases.get(issueId) ?? null);
  }

  setPhase(issueId: string, phaseName: string): Promise<void> {
    this.calls.push(`setPhase:${issueId}:${phaseName}`);
    this.phases.set(issueId, phaseName);
    return Promise.resolve();
  }

  assignToAi(issueId: string): Promise<void> {
    this.calls.push(`assignToAi:${issueId}`);
    this.assignments.set(issueId, "ai");
    return Promise.resolve();
  }

  assignToHuman(issueId: string, preferredAssignee?: string | null): Promise<void> {
    this.calls.push(`assignToHuman:${issueId}:${preferredAssignee ?? "none"}`);
    this.assignments.set(issueId, "human");
    return Promise.resolve();
  }

  getSpec(issueId: string): Promise<string | null> {
    return Promise.resolve(this.specs.get(issueId) ?? null);
  }

  setSpec(issueId: string, content: string): Promise<void> {
    this.specs.set(issueId, content);
    return Promise.resolve();
  }

  addComment(issueId: string, body: string): Promise<void> {
    this.commentCounter++;
    const list = this.commentsById.get(issueId) ?? [];
    list.push({
      id: String(this.commentCounter),
      author: "ai-user",
      body,
      createdAt: new Date().toISOString(),
    });
    this.commentsById.set(issueId, list);
    return Promise.resolve();
  }

  getComments(issueId: string): Promise<Comment[]> {
    return Promise.resolve(this.commentsById.get(issueId) ?? []);
  }

  listAttachments(): Promise<Attachment[]> {
    return Promise.resolve([]);
  }

  downloadAttachment(): Promise<void> {
    return Promise.resolve();
  }

  transitionTo(issueId: string, status: string): Promise<void> {
    this.calls.push(`transitionTo:${issueId}:${status}`);
    const issue = this.issues.get(issueId);
    if (issue !== undefined) {
      this.issues.set(issueId, { ...issue, status });
    }
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

export interface InMemorySourceControlSeed {
  branches?: string[];
}

export class InMemorySourceControl implements SourceControl {
  readonly branches = new Set<string>();
  readonly prs = new Map<number, PullRequest>();
  readonly reviews = new Map<number, { verdict: "approve" | "request-changes"; body: string }[]>();
  readonly checks = new Map<number, CheckStatus[]>();
  readonly reviewComments = new Map<number, Comment[]>();
  readonly calls: string[] = [];
  private prCounter = 0;

  constructor(seed: InMemorySourceControlSeed = {}) {
    for (const branch of seed.branches ?? []) {
      this.branches.add(branch);
    }
  }

  createBranch(name: string): Promise<void> {
    this.calls.push(`createBranch:${name}`);
    this.branches.add(name);
    return Promise.resolve();
  }

  deleteBranch(name: string): Promise<void> {
    this.calls.push(`deleteBranch:${name}`);
    this.branches.delete(name);
    return Promise.resolve();
  }

  branchExists(name: string): Promise<boolean> {
    return Promise.resolve(this.branches.has(name));
  }

  createPullRequest(options: CreatePROptions): Promise<PullRequest> {
    this.prCounter++;
    const pr: PullRequest = {
      number: this.prCounter,
      title: options.title,
      state: "open",
      headBranch: options.head,
      baseBranch: options.base,
      url: `https://example.test/pr/${String(this.prCounter)}`,
      reviewDecision: null,
    };
    this.prs.set(this.prCounter, pr);
    this.calls.push(`createPullRequest:${String(this.prCounter)}:${options.head}`);
    return Promise.resolve(pr);
  }

  getPullRequest(prNumber: number): Promise<PullRequest | null> {
    return Promise.resolve(this.prs.get(prNumber) ?? null);
  }

  getPullRequestDiff(): Promise<string> {
    return Promise.resolve("");
  }

  mergePullRequest(prNumber: number): Promise<void> {
    this.calls.push(`mergePullRequest:${String(prNumber)}`);
    const pr = this.prs.get(prNumber);
    if (pr !== undefined) {
      this.prs.set(prNumber, { ...pr, state: "merged" });
    }
    return Promise.resolve();
  }

  postReview(
    prNumber: number,
    body: string,
    verdict: "approve" | "request-changes",
  ): Promise<void> {
    this.calls.push(`postReview:${String(prNumber)}:${verdict}`);
    const list = this.reviews.get(prNumber) ?? [];
    list.push({ verdict, body });
    this.reviews.set(prNumber, list);
    const pr = this.prs.get(prNumber);
    if (pr !== undefined) {
      this.prs.set(prNumber, {
        ...pr,
        reviewDecision: verdict === "approve" ? "APPROVED" : "CHANGES_REQUESTED",
      });
    }
    return Promise.resolve();
  }

  dismissStaleReviews(): Promise<void> {
    return Promise.resolve();
  }

  getReviewComments(prNumber: number): Promise<Comment[]> {
    return Promise.resolve(this.reviewComments.get(prNumber) ?? []);
  }

  replyToComment(): Promise<void> {
    return Promise.resolve();
  }

  getChecks(prNumber: number): Promise<CheckStatus[]> {
    return Promise.resolve(this.checks.get(prNumber) ?? []);
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

export function makeIssue(overrides: Partial<Issue> & Pick<Issue, "id">): Issue {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    key: overrides.key ?? overrides.id,
    summary: overrides.summary ?? `Test issue ${overrides.id}`,
    status: overrides.status ?? "Open",
    phase: overrides.phase ?? null,
    assignee: overrides.assignee ?? null,
    reporter: overrides.reporter ?? null,
    issueType: overrides.issueType ?? "feature",
    labels: overrides.labels ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}
