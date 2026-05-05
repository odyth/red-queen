import { createHmac, timingSafeEqual } from "node:crypto";
import type { PipelineEvent } from "../../core/types.js";

// Jira Cloud webhooks do not natively sign payloads. For HMAC validation to work,
// the delivery path must attach an `x-hub-signature` header (e.g. via Jira Automation
// "Send web request" with a computed HMAC, or an intermediate gateway). If your
// deployment can't provide that, omit `webhookSecret` and rely on network-level
// controls for the webhook endpoint.
export function validateJiraWebhook(
  secret: string | null,
  headers: Record<string, string>,
  body: string,
): boolean {
  if (secret === null || secret.length === 0) {
    return false;
  }
  const signature = headers["x-hub-signature"];
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

export interface JiraWebhookContext {
  botAccountId: string;
  phaseFieldId: string;
  phaseOptionToName: (optionId: string) => string | null;
}

interface ChangelogItem {
  fieldId?: string;
  field?: string;
  from?: string | null;
  fromString?: string | null;
  to?: string | null;
  toString?: string | null;
}

export function parseJiraWebhookEvent(
  context: JiraWebhookContext,
  _headers: Record<string, string>,
  body: string,
): PipelineEvent | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  const webhookEvent = extractString(payload, "webhookEvent");
  if (webhookEvent !== "jira:issue_updated") {
    return null;
  }

  const userAccount = extractNested(payload, ["user", "accountId"]);
  if (typeof userAccount === "string" && userAccount === context.botAccountId) {
    return null;
  }

  const issueKey = extractNested(payload, ["issue", "key"]);
  if (typeof issueKey !== "string") {
    return null;
  }

  const items = extractNested(payload, ["changelog", "items"]);
  if (Array.isArray(items) === false) {
    return null;
  }

  const nowIso = new Date().toISOString();
  const delegator: string | null = typeof userAccount === "string" ? userAccount : null;

  for (const raw of items as ChangelogItem[]) {
    const fieldId = raw.fieldId ?? raw.field;
    if (fieldId === context.phaseFieldId) {
      const toValue = raw.to ?? null;
      if (toValue === null) {
        continue;
      }
      const phaseName = context.phaseOptionToName(toValue);
      if (phaseName === null) {
        continue;
      }
      return {
        source: "webhook",
        type: "phase-change",
        issueId: issueKey,
        timestamp: nowIso,
        payload: { phase: phaseName, delegator },
      };
    }
    if (fieldId === "assignee") {
      if (raw.to === context.botAccountId) {
        return {
          source: "webhook",
          type: "assignment-change",
          issueId: issueKey,
          timestamp: nowIso,
          payload: { delegator },
        };
      }
    }
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
