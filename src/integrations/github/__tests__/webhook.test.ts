import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { GitHubIdentity } from "../auth.js";
import { parseGitHubWebhookEvent, validateGitHubWebhook } from "../webhook.js";

const SECRET = "topsecret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

describe("validateGitHubWebhook", () => {
  it("accepts valid signature", () => {
    const body = JSON.stringify({ action: "created" });
    const headers = { "x-hub-signature-256": sign(body) };
    expect(validateGitHubWebhook(SECRET, headers, body)).toBe(true);
  });

  it("rejects invalid signature", () => {
    const body = JSON.stringify({ action: "created" });
    expect(validateGitHubWebhook(SECRET, { "x-hub-signature-256": "sha256=abc" }, body)).toBe(
      false,
    );
  });

  it("rejects missing header", () => {
    expect(validateGitHubWebhook(SECRET, {}, "{}")).toBe(false);
  });

  it("rejects malformed header", () => {
    expect(validateGitHubWebhook(SECRET, { "x-hub-signature-256": "garbage" }, "{}")).toBe(false);
  });

  it("rejects when secret unconfigured", () => {
    const body = "{}";
    expect(validateGitHubWebhook(null, { "x-hub-signature-256": sign(body) }, body)).toBe(false);
  });
});

describe("parseGitHubWebhookEvent", () => {
  const identity: GitHubIdentity = { login: "bot", accountId: "1", isBot: true };

  it("returns null for self-echo", () => {
    const payload = JSON.stringify({
      action: "created",
      sender: { login: "bot" },
      issue: { number: 5 },
    });
    const result = parseGitHubWebhookEvent(
      { identity },
      { "x-github-event": "issue_comment" },
      payload,
    );
    expect(result).toBeNull();
  });

  it("returns pr-feedback for foreign issue_comment", () => {
    const payload = JSON.stringify({
      action: "created",
      sender: { login: "human" },
      issue: { number: 42 },
    });
    const result = parseGitHubWebhookEvent(
      { identity },
      { "x-github-event": "issue_comment" },
      payload,
    );
    expect(result?.type).toBe("pr-feedback");
    expect(result?.issueId).toBe("#42");
  });

  it("returns pr-merged on closed+merged", () => {
    const payload = JSON.stringify({
      action: "closed",
      sender: { login: "human" },
      pull_request: { merged: true, head: { ref: "feature/123" } },
    });
    const result = parseGitHubWebhookEvent(
      { identity },
      { "x-github-event": "pull_request" },
      payload,
    );
    expect(result?.type).toBe("pr-merged");
    expect(result?.issueId).toBe("#123");
  });

  it("returns phase-change on label add", () => {
    const payload = JSON.stringify({
      action: "labeled",
      sender: { login: "human" },
      issue: { number: 7 },
      label: { name: "rq:phase:coding" },
    });
    const result = parseGitHubWebhookEvent({ identity }, { "x-github-event": "issues" }, payload);
    expect(result?.type).toBe("phase-change");
    expect(result?.issueId).toBe("#7");
    expect(result?.payload.phase).toBe("coding");
  });

  it("ignores non-rq labels", () => {
    const payload = JSON.stringify({
      action: "labeled",
      sender: { login: "human" },
      issue: { number: 7 },
      label: { name: "bug" },
    });
    const result = parseGitHubWebhookEvent({ identity }, { "x-github-event": "issues" }, payload);
    expect(result).toBeNull();
  });

  it("returns null for unsupported events", () => {
    const payload = JSON.stringify({ action: "whatever", sender: { login: "x" } });
    const result = parseGitHubWebhookEvent({ identity }, { "x-github-event": "push" }, payload);
    expect(result).toBeNull();
  });

  it("parses Jira-style branch names", () => {
    const payload = JSON.stringify({
      action: "closed",
      sender: { login: "human" },
      pull_request: { merged: true, head: { ref: "feature/RQ-42" } },
    });
    const result = parseGitHubWebhookEvent(
      { identity },
      { "x-github-event": "pull_request" },
      payload,
    );
    expect(result?.issueId).toBe("RQ-42");
  });

  it("returns null for bad JSON", () => {
    const result = parseGitHubWebhookEvent(
      { identity },
      { "x-github-event": "issues" },
      "{not-json",
    );
    expect(result).toBeNull();
  });
});
