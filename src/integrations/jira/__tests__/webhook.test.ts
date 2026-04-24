import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { parseJiraWebhookEvent, validateJiraWebhook } from "../webhook.js";

const SECRET = "topsecret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

describe("validateJiraWebhook", () => {
  it("accepts valid signature", () => {
    const body = JSON.stringify({ webhookEvent: "jira:issue_updated" });
    expect(validateJiraWebhook(SECRET, { "x-hub-signature": sign(body) }, body)).toBe(true);
  });

  it("rejects invalid signature", () => {
    const body = "{}";
    expect(validateJiraWebhook(SECRET, { "x-hub-signature": "sha256=abc" }, body)).toBe(false);
  });

  it("rejects missing signature", () => {
    expect(validateJiraWebhook(SECRET, {}, "{}")).toBe(false);
  });

  it("rejects when secret unconfigured", () => {
    const body = "{}";
    expect(validateJiraWebhook(null, { "x-hub-signature": sign(body) }, body)).toBe(false);
  });
});

describe("parseJiraWebhookEvent", () => {
  const ctx = {
    botAccountId: "bot-1",
    phaseFieldId: "customfield_10158",
    phaseOptionToName: (optionId: string): string | null => {
      return optionId === "10056" ? "coding" : null;
    },
  };

  it("drops self-echo events", () => {
    const body = JSON.stringify({
      webhookEvent: "jira:issue_updated",
      user: { accountId: "bot-1" },
      issue: { key: "RQ-1" },
      changelog: {
        items: [{ fieldId: "customfield_10158", to: "10056" }],
      },
    });
    expect(parseJiraWebhookEvent(ctx, {}, body)).toBeNull();
  });

  it("returns phase-change on AI Phase update", () => {
    const body = JSON.stringify({
      webhookEvent: "jira:issue_updated",
      user: { accountId: "human-1" },
      issue: { key: "RQ-1" },
      changelog: {
        items: [{ fieldId: "customfield_10158", to: "10056" }],
      },
    });
    const result = parseJiraWebhookEvent(ctx, {}, body);
    expect(result?.type).toBe("phase-change");
    expect(result?.issueId).toBe("RQ-1");
    expect(result?.payload.phase).toBe("coding");
  });

  it("emits assignment-change when assigned to bot", () => {
    const body = JSON.stringify({
      webhookEvent: "jira:issue_updated",
      user: { accountId: "human-1" },
      issue: { key: "RQ-1" },
      changelog: {
        items: [{ fieldId: "assignee", to: "bot-1" }],
      },
    });
    const result = parseJiraWebhookEvent(ctx, {}, body);
    expect(result?.type).toBe("assignment-change");
  });

  it("skips unmapped phase option IDs", () => {
    const body = JSON.stringify({
      webhookEvent: "jira:issue_updated",
      user: { accountId: "human-1" },
      issue: { key: "RQ-1" },
      changelog: {
        items: [{ fieldId: "customfield_10158", to: "99999" }],
      },
    });
    expect(parseJiraWebhookEvent(ctx, {}, body)).toBeNull();
  });

  it("returns null for non-update webhookEvent", () => {
    const body = JSON.stringify({ webhookEvent: "jira:issue_created" });
    expect(parseJiraWebhookEvent(ctx, {}, body)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseJiraWebhookEvent(ctx, {}, "{bad")).toBeNull();
  });
});
