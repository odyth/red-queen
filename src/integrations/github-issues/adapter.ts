import { z } from "zod";
import type { Comment, PipelineEvent, ValidationResult } from "../../core/types.js";
import type { Attachment, Issue, IssueTracker } from "../issue-tracker.js";
import { parseGitHubWebhookEvent, validateGitHubWebhook } from "../github/webhook.js";
import type { GitHubAuthStrategy, GitHubIdentity } from "../github/auth.js";
import { GitHubAuthConfigSchema } from "../github/auth/config.js";
import type { GitHubClient } from "../github/client.js";
import { ACTIVE_LABEL, colorFor, isPhaseLabel, phaseFromLabel, phaseLabel } from "./labels.js";
import { findSpec, formatSpecBody } from "./spec-marker.js";

export const GitHubIssuesConfigSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  auth: GitHubAuthConfigSchema.optional(),
  webhookSecret: z.string().optional(),
});

export type GitHubIssuesConfig = z.infer<typeof GitHubIssuesConfigSchema>;

export interface GitHubIssuesAdapterOptions {
  client: GitHubClient;
  owner: string;
  repo: string;
  webhookSecret: string | null;
  audit?: (message: string, metadata: Record<string, unknown>) => void;
}

interface OctokitRestError extends Error {
  status?: number;
}

export class GitHubIssuesAdapter implements IssueTracker {
  private readonly client: GitHubClient;
  private readonly owner: string;
  private readonly repo: string;
  private readonly webhookSecret: string | null;
  private readonly audit: (message: string, metadata: Record<string, unknown>) => void;
  private identityCached: GitHubIdentity | null = null;
  private identityPromise: Promise<GitHubIdentity> | null = null;
  private ensuredLabels = new Set<string>();

  constructor(options: GitHubIssuesAdapterOptions) {
    this.client = options.client;
    this.owner = options.owner;
    this.repo = options.repo;
    this.webhookSecret = options.webhookSecret;
    this.audit = options.audit ?? ((): void => undefined);
  }

  get auth(): GitHubAuthStrategy {
    return this.client.auth;
  }

  async getIssue(issueId: string): Promise<Issue> {
    const number = parseIssueId(issueId);
    const response = await this.client.call(
      `GET /repos/${this.owner}/${this.repo}/issues/${String(number)}`,
      () =>
        this.client.rest.issues.get({
          owner: this.owner,
          repo: this.repo,
          issue_number: number,
        }),
    );
    return toIssue(response.data);
  }

  async listIssuesByPhase(phaseName: string): Promise<Issue[]> {
    const label = phaseLabel(phaseName);
    const items = (await this.client.paginate(this.client.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      labels: label,
      state: "open",
      per_page: 100,
    })) as IssueRaw[];
    return items.filter((i) => i.pull_request === undefined).map(toIssue);
  }

  async getPhase(issueId: string): Promise<string | null> {
    const issue = await this.getIssue(issueId);
    return issue.phase;
  }

  async setPhase(issueId: string, phaseName: string): Promise<void> {
    const number = parseIssueId(issueId);
    const desired = phaseLabel(phaseName);
    await this.ensureLabel(desired);
    const issue = await this.getIssue(issueId);
    const existingPhaseLabels = issue.labels.filter(isPhaseLabel);
    for (const existing of existingPhaseLabels) {
      if (existing === desired) {
        continue;
      }
      await this.removeLabel(number, existing);
    }
    if (existingPhaseLabels.includes(desired) === false) {
      await this.addLabels(number, [desired]);
    }
  }

  async assignToAi(issueId: string): Promise<void> {
    const number = parseIssueId(issueId);
    await this.ensureLabel(ACTIVE_LABEL);
    await this.addLabels(number, [ACTIVE_LABEL]);
  }

  async assignToHuman(issueId: string, preferredAssignee?: string | null): Promise<void> {
    const number = parseIssueId(issueId);
    try {
      await this.removeLabel(number, ACTIVE_LABEL);
    } catch (err) {
      if (isNotFound(err) === false) {
        throw err;
      }
    }
    const issue = await this.getIssue(issueId);
    const target = preferredAssignee ?? issue.reporter;
    if (target !== null) {
      await this.addComment(
        issueId,
        `@${target} needs your review (phase: ${issue.phase ?? "human-review"}).`,
      );
      try {
        await this.client.call(
          `POST /repos/${this.owner}/${this.repo}/issues/${String(number)}/assignees`,
          () =>
            this.client.rest.issues.addAssignees({
              owner: this.owner,
              repo: this.repo,
              issue_number: number,
              assignees: [target],
            }),
        );
      } catch (err) {
        // 422 or 403 — not assignable. Swallow; the comment covers us.
        this.audit(`assignToHuman: could not assign ${target}`, {
          error: (err as Error).message,
        });
      }
    }
  }

  async getSpec(issueId: string): Promise<string | null> {
    const number = parseIssueId(issueId);
    const comments = (await this.client.paginate(this.client.rest.issues.listComments, {
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      per_page: 100,
    })) as { id: number; body: string | null; created_at?: string }[];
    const lookup = findSpec(comments);
    if (lookup.duplicateCount > 0) {
      this.audit(`getSpec: duplicate marker comments for issue ${issueId}`, {
        duplicateCount: lookup.duplicateCount,
      });
    }
    return lookup.content;
  }

  async setSpec(issueId: string, content: string): Promise<void> {
    const number = parseIssueId(issueId);
    const comments = (await this.client.paginate(this.client.rest.issues.listComments, {
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      per_page: 100,
    })) as { id: number; body: string | null; created_at?: string }[];
    const lookup = findSpec(comments);
    const body = formatSpecBody(content);
    const commentId = lookup.markerCommentId;
    if (commentId !== null) {
      await this.client.call(
        `PATCH /repos/${this.owner}/${this.repo}/issues/comments/${String(commentId)}`,
        () =>
          this.client.rest.issues.updateComment({
            owner: this.owner,
            repo: this.repo,
            comment_id: commentId,
            body,
          }),
      );
      return;
    }
    await this.client.call(
      `POST /repos/${this.owner}/${this.repo}/issues/${String(number)}/comments`,
      () =>
        this.client.rest.issues.createComment({
          owner: this.owner,
          repo: this.repo,
          issue_number: number,
          body,
        }),
    );
  }

  async addComment(issueId: string, body: string): Promise<void> {
    const number = parseIssueId(issueId);
    await this.client.call(
      `POST /repos/${this.owner}/${this.repo}/issues/${String(number)}/comments`,
      () =>
        this.client.rest.issues.createComment({
          owner: this.owner,
          repo: this.repo,
          issue_number: number,
          body,
        }),
    );
  }

  async getComments(issueId: string): Promise<Comment[]> {
    const number = parseIssueId(issueId);
    const comments = (await this.client.paginate(this.client.rest.issues.listComments, {
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      per_page: 100,
    })) as {
      id: number;
      user: { login?: string } | null;
      body: string | null;
      created_at?: string;
    }[];
    return comments.map((c) => ({
      id: String(c.id),
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      createdAt: c.created_at ?? "",
    }));
  }

  listAttachments(): Promise<Attachment[]> {
    return Promise.resolve([]);
  }

  downloadAttachment(): Promise<void> {
    return Promise.resolve();
  }

  transitionTo(): Promise<void> {
    // GitHub Issues has no workflow transitions — no-op.
    return Promise.resolve();
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
    return parseGitHubWebhookEvent({ identity: this.identityCached }, headers, body);
  }

  validateConfig(config: Record<string, unknown>): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const result = GitHubIssuesConfigSchema.safeParse(config);
    if (result.success === false) {
      for (const issue of result.error.issues) {
        errors.push(`${issue.path.join(".")}: ${issue.message}`);
      }
    }
    return { errors, warnings };
  }

  validatePhaseMapping(): ValidationResult {
    // Labels are self-healing — no mapping config required.
    return { errors: [], warnings: [] };
  }

  async warmIdentity(): Promise<GitHubIdentity> {
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

  private async ensureLabel(name: string): Promise<void> {
    if (this.ensuredLabels.has(name)) {
      return;
    }
    try {
      await this.client.call(`GET /repos/${this.owner}/${this.repo}/labels/${name}`, () =>
        this.client.rest.issues.getLabel({
          owner: this.owner,
          repo: this.repo,
          name,
        }),
      );
      this.ensuredLabels.add(name);
      return;
    } catch (err) {
      if (isNotFound(err) === false) {
        throw err;
      }
    }
    try {
      await this.client.call(`POST /repos/${this.owner}/${this.repo}/labels`, () =>
        this.client.rest.issues.createLabel({
          owner: this.owner,
          repo: this.repo,
          name,
          color: colorFor(name),
        }),
      );
    } catch (err) {
      // 422 = already exists (race). Treat as success.
      if ((err as OctokitRestError).status !== 422) {
        throw err;
      }
    }
    this.ensuredLabels.add(name);
  }

  private async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) {
      return;
    }
    await this.client.call(
      `POST /repos/${this.owner}/${this.repo}/issues/${String(issueNumber)}/labels`,
      () =>
        this.client.rest.issues.addLabels({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          labels,
        }),
    );
  }

  private async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.client.call(
        `DELETE /repos/${this.owner}/${this.repo}/issues/${String(issueNumber)}/labels/${label}`,
        () =>
          this.client.rest.issues.removeLabel({
            owner: this.owner,
            repo: this.repo,
            issue_number: issueNumber,
            name: label,
          }),
      );
    } catch (err) {
      if (isNotFound(err)) {
        return;
      }
      throw err;
    }
  }
}

interface IssueRaw {
  number: number;
  title: string;
  state: string;
  labels: (string | { name?: string | null } | null)[];
  assignee?: { login?: string | null } | null;
  assignees?: { login?: string }[] | null;
  user?: { login?: string | null } | null;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

function toIssue(raw: IssueRaw): Issue {
  const labelNames = raw.labels
    .map((l) => {
      if (l === null) {
        return null;
      }
      return typeof l === "string" ? l : (l.name ?? null);
    })
    .filter((n): n is string => n !== null);
  const phase = labelNames.map(phaseFromLabel).find((p): p is string => p !== null) ?? null;
  return {
    id: `#${String(raw.number)}`,
    key: `#${String(raw.number)}`,
    summary: raw.title,
    status: raw.state,
    phase,
    assignee: raw.assignee?.login ?? null,
    reporter: raw.user?.login ?? null,
    issueType: "feature",
    labels: labelNames,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function parseIssueId(issueId: string): number {
  const trimmed = issueId.startsWith("#") ? issueId.slice(1) : issueId;
  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isFinite(parsed) === false) {
    throw new Error(`Invalid GitHub issue id: ${issueId}`);
  }
  return parsed;
}

function isNotFound(err: unknown): boolean {
  return (err as OctokitRestError).status === 404;
}
