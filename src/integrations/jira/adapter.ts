import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { Comment, PipelineEvent, ValidationResult } from "../../core/types.js";
import type { Attachment, Issue, IssueTracker } from "../issue-tracker.js";
import { fromAdf, toAdf } from "./adf.js";
import type { AdfNode } from "./adf.js";
import { JiraClient } from "./client.js";
import { parseJiraWebhookEvent, validateJiraWebhook } from "./webhook.js";

export const JiraConfigSchema = z.object({
  baseUrl: z.url(),
  email: z.email(),
  apiToken: z.string().min(1),
  cloudId: z.string().optional(),
  projectKey: z.string().min(1),
  customFields: z.object({
    phase: z.string().min(1),
    spec: z.string().min(1),
  }),
  phaseMapping: z.record(
    z.string(),
    z.object({
      optionId: z.string().min(1),
      label: z.string().optional(),
    }),
  ),
  statusTransitions: z
    .object({
      inProgress: z.string().optional(),
      done: z.string().optional(),
    })
    .default({}),
  botAccountId: z.string().optional(),
  webhookSecret: z.string().optional(),
});

export type JiraAdapterConfig = z.infer<typeof JiraConfigSchema>;

export interface JiraAdapterOptions {
  client: JiraClient;
  config: JiraAdapterConfig;
  audit?: (message: string, metadata: Record<string, unknown>) => void;
  /**
   * Maximum bytes to accept per attachment download. Defaults to 100MB. Streams
   * are aborted once the cap is exceeded so a hostile (or corrupted) upload
   * cannot fill disk.
   */
  maxAttachmentBytes?: number;
}

interface JiraIssueRaw {
  id: string;
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string };
    assignee?: { accountId?: string; displayName?: string } | null;
    reporter?: { accountId?: string; displayName?: string } | null;
    issuetype?: { name?: string };
    labels?: string[];
    created?: string;
    updated?: string;
    attachment?: JiraAttachmentRaw[];
    [fieldId: string]: unknown;
  };
}

interface JiraAttachmentRaw {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  content: string;
}

interface JiraCommentRaw {
  id: string;
  author?: { displayName?: string; accountId?: string };
  body?: AdfNode;
  renderedBody?: string;
  created?: string;
}

interface JiraTransitionRaw {
  id: string;
  name: string;
  to?: { name?: string };
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export class JiraIssueTrackerAdapter implements IssueTracker {
  private readonly client: JiraClient;
  private readonly config: JiraAdapterConfig;
  private readonly phaseByOptionId: Map<string, string>;
  private readonly audit: (message: string, metadata: Record<string, unknown>) => void;
  private readonly maxAttachmentBytes: number;
  private botAccountId: string | null;
  private transitionCache = new Map<string, JiraTransitionRaw[]>();

  constructor(options: JiraAdapterOptions) {
    this.client = options.client;
    this.config = options.config;
    this.phaseByOptionId = new Map();
    for (const [phaseName, mapping] of Object.entries(options.config.phaseMapping)) {
      this.phaseByOptionId.set(mapping.optionId, phaseName);
    }
    this.audit = options.audit ?? ((): void => undefined);
    this.maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    this.botAccountId = options.config.botAccountId ?? null;
  }

  async getIssue(issueId: string): Promise<Issue> {
    const raw = await this.client.request<JiraIssueRaw>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueId)}`,
    );
    return this.toIssue(raw);
  }

  async listIssuesByPhase(phaseName: string): Promise<Issue[]> {
    const mapping = this.config.phaseMapping[phaseName];
    if (mapping === undefined) {
      return [];
    }
    const jql = `project = "${escapeJql(this.config.projectKey)}" AND "${this.config.customFields.phase}" = "${escapeJql(mapping.optionId)}"`;
    const response = await this.client.request<{ issues?: JiraIssueRaw[] }>(
      "POST",
      "/rest/api/3/search",
      {
        jql,
        fields: [
          "summary",
          "status",
          "assignee",
          "reporter",
          "issuetype",
          "labels",
          "created",
          "updated",
          this.config.customFields.phase,
          this.config.customFields.spec,
        ],
        maxResults: 50,
      },
    );
    return (response.issues ?? []).map((r) => this.toIssue(r));
  }

  async getPhase(issueId: string): Promise<string | null> {
    const issue = await this.getIssue(issueId);
    return issue.phase;
  }

  async setPhase(issueId: string, phaseName: string): Promise<void> {
    const mapping = this.config.phaseMapping[phaseName];
    if (mapping === undefined) {
      this.audit(`Jira: no phaseMapping for ${phaseName} — skipping setPhase`, { phaseName });
      return;
    }
    await this.client.request("PUT", `/rest/api/3/issue/${encodeURIComponent(issueId)}`, {
      fields: {
        [this.config.customFields.phase]: { id: mapping.optionId },
      },
    });
  }

  async assignToAi(issueId: string): Promise<void> {
    const accountId = await this.ensureBotAccountId();
    await this.client.request("PUT", `/rest/api/3/issue/${encodeURIComponent(issueId)}/assignee`, {
      accountId,
    });
  }

  async assignToHuman(issueId: string): Promise<void> {
    const issue = await this.getIssue(issueId);
    await this.client.request("PUT", `/rest/api/3/issue/${encodeURIComponent(issueId)}/assignee`, {
      accountId: issue.reporter ?? null,
    });
  }

  async getSpec(issueId: string): Promise<string | null> {
    const raw = await this.client.request<JiraIssueRaw>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueId)}?fields=${this.config.customFields.spec}`,
    );
    const value = raw.fields[this.config.customFields.spec];
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "string") {
      return value;
    }
    return fromAdf(value as AdfNode);
  }

  async setSpec(issueId: string, content: string): Promise<void> {
    await this.client.request("PUT", `/rest/api/3/issue/${encodeURIComponent(issueId)}`, {
      fields: {
        [this.config.customFields.spec]: toAdf(content),
      },
    });
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.client.request("POST", `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`, {
      body: toAdf(body),
    });
  }

  async getComments(issueId: string): Promise<Comment[]> {
    const response = await this.client.request<{ comments?: JiraCommentRaw[] }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`,
    );
    return (response.comments ?? []).map((c) => ({
      id: c.id,
      author: c.author?.displayName ?? c.author?.accountId ?? "unknown",
      body:
        typeof c.renderedBody === "string"
          ? c.renderedBody
          : c.body === undefined
            ? ""
            : fromAdf(c.body),
      createdAt: c.created ?? "",
    }));
  }

  async listAttachments(issueId: string): Promise<Attachment[]> {
    const raw = await this.client.request<JiraIssueRaw>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueId)}?fields=attachment`,
    );
    const attachments = raw.fields.attachment ?? [];
    return attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.mimeType,
      sizeBytes: a.size,
      url: a.content,
      localPath: null,
    }));
  }

  async downloadAttachment(attachment: Attachment, destPath: string): Promise<void> {
    await mkdir(dirname(destPath), { recursive: true });
    const response = await fetch(attachment.url, {
      headers: {
        Authorization: this.client.authorization,
        Accept: attachment.contentType || "application/octet-stream",
      },
    });
    if (response.ok === false) {
      throw new Error(`Jira attachment download failed: HTTP ${String(response.status)}`);
    }
    const bodyStream = response.body;
    if (bodyStream === null) {
      throw new Error("Jira attachment download: empty response body");
    }
    // Cap at whichever is smaller: the globally-configured max, or the declared
    // attachment size with a small slack for metadata overhead.
    const declaredCap =
      attachment.sizeBytes > 0 ? attachment.sizeBytes + 1024 : Number.POSITIVE_INFINITY;
    const cap = Math.min(this.maxAttachmentBytes, declaredCap);

    let received = 0;
    const cappedReadable = Readable.fromWeb(
      bodyStream as unknown as Parameters<typeof Readable.fromWeb>[0],
    );
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb): void {
        received += chunk.length;
        if (received > cap) {
          cb(
            new Error(
              `Jira attachment download exceeded size cap (${String(cap)} bytes, attachment id=${attachment.id})`,
            ),
          );
          return;
        }
        cb(null, chunk);
      },
    });
    const writeStream = createWriteStream(destPath);
    try {
      await pipeline(cappedReadable, limiter, writeStream);
    } catch (err) {
      await unlink(destPath).catch((): void => undefined);
      throw err;
    }
    attachment.localPath = destPath;
  }

  async transitionTo(issueId: string, status: string): Promise<void> {
    const issue = await this.getIssue(issueId);
    const transitions = await this.loadTransitions(issueId, issue.issueType);
    const match = transitions.find((t) => t.to?.name === status || t.name === status);
    if (match === undefined) {
      const available = transitions.map((t) => t.to?.name ?? t.name).join(", ");
      throw new Error(
        `Jira: no transition available to '${status}' for ${issueId}. Available: [${available}]`,
      );
    }
    await this.client.request(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(issueId)}/transitions`,
      { transition: { id: match.id } },
    );
  }

  validateWebhook(headers: Record<string, string>, body: string): boolean {
    return validateJiraWebhook(this.config.webhookSecret ?? null, headers, body);
  }

  parseWebhookEvent(headers: Record<string, string>, body: string): PipelineEvent | null {
    if (this.botAccountId === null) {
      this.audit(
        "Jira webhook dropped: bot identity not warmed yet (warmIdentity hasn't resolved)",
        {
          event: headers["x-atlassian-webhook-identifier"] ?? null,
        },
      );
      return null;
    }
    return parseJiraWebhookEvent(
      {
        botAccountId: this.botAccountId,
        phaseFieldId: this.config.customFields.phase,
        phaseOptionToName: (optionId) => this.phaseByOptionId.get(optionId) ?? null,
      },
      headers,
      body,
    );
  }

  validateConfig(config: Record<string, unknown>): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const result = JiraConfigSchema.safeParse(config);
    if (result.success === false) {
      for (const issue of result.error.issues) {
        errors.push(`${issue.path.join(".")}: ${issue.message}`);
      }
    }
    return { errors, warnings };
  }

  validatePhaseMapping(phaseNames: string[]): ValidationResult {
    const warnings: string[] = [];
    for (const name of phaseNames) {
      if (this.config.phaseMapping[name] === undefined) {
        warnings.push(
          `Jira: no option mapping for phase '${name}' — issues in this phase won't reflect in the AI Phase dropdown field. Add phaseMapping.${name} to redqueen.yaml.`,
        );
      }
    }
    return { errors: [], warnings };
  }

  async warmIdentity(): Promise<string> {
    return this.ensureBotAccountId();
  }

  private async ensureBotAccountId(): Promise<string> {
    if (this.botAccountId !== null) {
      return this.botAccountId;
    }
    const me = await this.client.request<{ accountId?: string }>("GET", "/rest/api/3/myself");
    if (me.accountId === undefined) {
      throw new Error("Jira /myself did not return an accountId");
    }
    this.botAccountId = me.accountId;
    return me.accountId;
  }

  private async loadTransitions(issueKey: string, issueType: string): Promise<JiraTransitionRaw[]> {
    const cacheKey = `${this.config.projectKey}:${issueType}`;
    const cached = this.transitionCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const response = await this.client.request<{ transitions?: JiraTransitionRaw[] }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    );
    const transitions = response.transitions ?? [];
    this.transitionCache.set(cacheKey, transitions);
    return transitions;
  }

  private toIssue(raw: JiraIssueRaw): Issue {
    const phaseField = raw.fields[this.config.customFields.phase];
    let phase: string | null = null;
    if (phaseField !== null && phaseField !== undefined) {
      const optionId =
        typeof phaseField === "string" ? phaseField : ((phaseField as { id?: string }).id ?? null);
      if (optionId !== null) {
        phase = this.phaseByOptionId.get(optionId) ?? null;
      }
    }
    return {
      id: raw.id,
      key: raw.key,
      summary: raw.fields.summary ?? "",
      status: raw.fields.status?.name ?? "unknown",
      phase,
      assignee: raw.fields.assignee?.accountId ?? null,
      reporter: raw.fields.reporter?.accountId ?? null,
      issueType: raw.fields.issuetype?.name ?? "unknown",
      labels: raw.fields.labels ?? [],
      createdAt: raw.fields.created ?? "",
      updatedAt: raw.fields.updated ?? "",
    };
  }
}

function escapeJql(input: string): string {
  return input.replace(/"/g, '\\"');
}
