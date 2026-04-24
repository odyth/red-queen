import type { Comment, PipelineEvent, ValidationResult } from "../core/types.js";

export interface Issue {
  id: string;
  key: string;
  summary: string;
  status: string;
  phase: string | null;
  assignee: string | null;
  issueType: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  url: string;
  localPath: string | null;
}

export interface IssueTracker {
  // Issue lifecycle
  getIssue(issueId: string): Promise<Issue>;
  listIssuesByPhase(phaseName: string): Promise<Issue[]>;

  // Phase management (adapter maps string names to native storage)
  getPhase(issueId: string): Promise<string | null>;
  setPhase(issueId: string, phaseName: string): Promise<void>;

  // Assignment
  assignToAi(issueId: string): Promise<void>;
  assignToHuman(issueId: string): Promise<void>;

  // Spec storage (adapter-owned)
  getSpec(issueId: string): Promise<string | null>;
  setSpec(issueId: string, content: string): Promise<void>;

  // Comments
  addComment(issueId: string, body: string): Promise<void>;
  getComments(issueId: string): Promise<Comment[]>;

  // Attachments
  listAttachments(issueId: string): Promise<Attachment[]>;
  downloadAttachment(attachment: Attachment, destPath: string): Promise<void>;

  // Status transitions
  transitionTo(issueId: string, status: string): Promise<void>;

  // Webhook handling
  validateWebhook(headers: Record<string, string>, body: string): boolean;
  parseWebhookEvent(headers: Record<string, string>, body: string): PipelineEvent | null;

  // Validation
  validateConfig(config: Record<string, unknown>): ValidationResult;
  validatePhaseMapping(phaseNames: string[]): ValidationResult;
}
