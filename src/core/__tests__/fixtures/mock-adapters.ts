import type { Comment, PipelineEvent, ValidationResult } from "../../types.js";
import type { Issue, IssueTracker } from "../../../integrations/issue-tracker.js";
import type {
  CreatePROptions,
  PullRequest,
  SourceControl,
} from "../../../integrations/source-control.js";

export class MockIssueTracker implements IssueTracker {
  issues = new Map<string, Issue>();
  phases = new Map<string, string | null>();
  assignments = new Map<string, "ai" | "human">();
  specs = new Map<string, string>();
  commentsById = new Map<string, Comment[]>();
  listByPhaseResults = new Map<string, Issue[]>();
  parseResult: PipelineEvent | null = null;
  validateResult = true;
  calls: string[] = [];

  async getIssue(issueId: string): Promise<Issue> {
    this.calls.push(`getIssue:${issueId}`);
    const issue = this.issues.get(issueId);
    if (issue === undefined) {
      throw new Error(`Issue ${issueId} not found`);
    }
    return Promise.resolve(issue);
  }

  listIssuesByPhase(phaseName: string): Promise<Issue[]> {
    this.calls.push(`listIssuesByPhase:${phaseName}`);
    return Promise.resolve(this.listByPhaseResults.get(phaseName) ?? []);
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

  assignToHuman(issueId: string): Promise<void> {
    this.calls.push(`assignToHuman:${issueId}`);
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
    const list = this.commentsById.get(issueId) ?? [];
    list.push({
      id: String(list.length),
      author: "mock",
      body,
      createdAt: new Date().toISOString(),
    });
    this.commentsById.set(issueId, list);
    return Promise.resolve();
  }

  getComments(issueId: string): Promise<Comment[]> {
    return Promise.resolve(this.commentsById.get(issueId) ?? []);
  }

  transitionTo(issueId: string, status: string): Promise<void> {
    this.calls.push(`transitionTo:${issueId}:${status}`);
    return Promise.resolve();
  }

  validateWebhook(): boolean {
    return this.validateResult;
  }

  parseWebhookEvent(): PipelineEvent | null {
    return this.parseResult;
  }

  validateConfig(): ValidationResult {
    return { errors: [], warnings: [] };
  }

  validatePhaseMapping(): ValidationResult {
    return { errors: [], warnings: [] };
  }
}

export class MockSourceControl implements SourceControl {
  branches = new Set<string>();
  prs = new Map<number, PullRequest>();
  parseResult: PipelineEvent | null = null;
  validateResult = true;
  calls: string[] = [];

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
    const num = this.prs.size + 1;
    const pr: PullRequest = {
      number: num,
      title: options.title,
      state: "open",
      headBranch: options.head,
      baseBranch: options.base,
      url: `https://example.com/pr/${String(num)}`,
      reviewDecision: null,
    };
    this.prs.set(num, pr);
    return Promise.resolve(pr);
  }

  getPullRequest(prNumber: number): Promise<PullRequest | null> {
    return Promise.resolve(this.prs.get(prNumber) ?? null);
  }

  getPullRequestDiff(): Promise<string> {
    return Promise.resolve("");
  }

  mergePullRequest(prNumber: number): Promise<void> {
    const pr = this.prs.get(prNumber);
    if (pr !== undefined) {
      pr.state = "merged";
    }
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

  validateWebhook(): boolean {
    return this.validateResult;
  }

  parseWebhookEvent(): PipelineEvent | null {
    return this.parseResult;
  }

  validateConfig(): void {
    // no-op
  }
}

export function makeIssue(id: string, phase: string | null = null): Issue {
  return {
    id,
    key: id,
    summary: `Test issue ${id}`,
    status: "In Progress",
    phase,
    assignee: "ai",
    issueType: "task",
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
