import { createHmac, timingSafeEqual } from "node:crypto";
import type { PipelineEvent, PipelineEventType } from "../../core/types.js";
import type { GitHubIdentity } from "./auth.js";

const PHASE_LABEL_PREFIX = "rq:phase:";

export function validateGitHubWebhook(
  secret: string | null,
  headers: Record<string, string>,
  body: string,
): boolean {
  if (secret === null || secret.length === 0) {
    return false;
  }
  const signature = headers["x-hub-signature-256"];
  if (signature === undefined || signature.startsWith("sha256=") === false) {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export interface GitHubWebhookParseContext {
  identity: GitHubIdentity;
  resolveIssueIdFromBranch?: (branch: string) => string | null;
}

export function parseGitHubWebhookEvent(
  context: GitHubWebhookParseContext,
  headers: Record<string, string>,
  body: string,
): PipelineEvent | null {
  const eventType = headers["x-github-event"];
  if (eventType === undefined) {
    return null;
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }

  const sender = extractNested(payload, ["sender", "login"]);
  if (typeof sender === "string" && sender === context.identity.login) {
    return null;
  }

  const nowIso = new Date().toISOString();
  const resolver = context.resolveIssueIdFromBranch ?? defaultBranchIssueResolver;

  switch (eventType) {
    case "issue_comment":
    case "pull_request_review":
    case "pull_request_review_comment": {
      return buildFeedbackEvent(payload, resolver, nowIso);
    }
    case "pull_request": {
      const action = extractString(payload, "action");
      const merged = extractNested(payload, ["pull_request", "merged"]);
      if (action === "closed" && merged === true) {
        const headRef = extractNested(payload, ["pull_request", "head", "ref"]);
        const branch = typeof headRef === "string" ? headRef : null;
        const issueId = branch === null ? null : resolver(branch);
        if (issueId === null) {
          return null;
        }
        return {
          source: "webhook",
          type: "pr-merged",
          issueId,
          timestamp: nowIso,
          payload: { branch },
        };
      }
      return null;
    }
    case "issues": {
      const action = extractString(payload, "action");
      if (action !== "labeled") {
        return null;
      }
      const labelName = extractNested(payload, ["label", "name"]);
      if (typeof labelName !== "string" || labelName.startsWith(PHASE_LABEL_PREFIX) === false) {
        return null;
      }
      const phase = labelName.slice(PHASE_LABEL_PREFIX.length);
      const issueNumber = extractNested(payload, ["issue", "number"]);
      if (typeof issueNumber !== "number") {
        return null;
      }
      return {
        source: "webhook",
        type: "phase-change" as PipelineEventType,
        issueId: `#${String(issueNumber)}`,
        timestamp: nowIso,
        payload: { phase },
      };
    }
    default:
      return null;
  }
}

function buildFeedbackEvent(
  payload: Record<string, unknown>,
  resolver: (branch: string) => string | null,
  nowIso: string,
): PipelineEvent | null {
  const headRef =
    extractNested(payload, ["pull_request", "head", "ref"]) ??
    extractNested(payload, ["issue", "pull_request", "head", "ref"]);
  const branch = typeof headRef === "string" ? headRef : null;
  let issueId: string | null = null;
  if (branch !== null) {
    issueId = resolver(branch);
  }
  if (issueId === null) {
    const number = extractNested(payload, ["issue", "number"]);
    if (typeof number === "number") {
      issueId = `#${String(number)}`;
    }
  }
  if (issueId === null) {
    return null;
  }
  return {
    source: "webhook",
    type: "pr-feedback",
    issueId,
    timestamp: nowIso,
    payload: { branch },
  };
}

const BRANCH_JIRA_RE = /^(?:[a-z][a-z0-9-]*)\/([A-Z][A-Z0-9]+-\d+)$/;
const BRANCH_NUMERIC_RE = /^(?:[a-z][a-z0-9-]*)\/(\d+)$/;

function defaultBranchIssueResolver(branch: string): string | null {
  const jira = BRANCH_JIRA_RE.exec(branch);
  if (jira?.[1] !== undefined) {
    return jira[1];
  }
  const numeric = BRANCH_NUMERIC_RE.exec(branch);
  if (numeric?.[1] !== undefined) {
    return `#${numeric[1]}`;
  }
  return null;
}

function extractString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function extractNested(payload: unknown, path: string[]): unknown {
  let current: unknown = payload;
  for (const key of path) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
