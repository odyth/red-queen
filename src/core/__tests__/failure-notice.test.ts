import { describe, it, expect } from "vitest";
import { buildFailureNotice, looksLikeAuthFailure } from "../failure-notice.js";
import type { WorkerResult } from "../worker.js";

function failure(overrides: Partial<WorkerResult>): WorkerResult {
  return {
    success: false,
    exitCode: 1,
    elapsed: 1,
    summary: "",
    error: null,
    usage: null,
    reportedCostUsd: null,
    ...overrides,
  };
}

describe("looksLikeAuthFailure", () => {
  it("matches Claude auth/401 phrasings", () => {
    expect(looksLikeAuthFailure("API Error: 401 authentication_error")).toBe(true);
    expect(looksLikeAuthFailure("Invalid API key · Please run /login")).toBe(true);
    expect(looksLikeAuthFailure("Failed to authenticate")).toBe(true);
    expect(looksLikeAuthFailure("403 Forbidden")).toBe(true);
  });

  it("does not match ordinary failures", () => {
    expect(looksLikeAuthFailure("TypeError: cannot read property foo")).toBe(false);
    expect(looksLikeAuthFailure("Worker timeout (60s)")).toBe(false);
    expect(looksLikeAuthFailure("Exit code 1")).toBe(false);
  });
});

describe("buildFailureNotice", () => {
  it("renders an auth-specific notice with the raw output", () => {
    const body = buildFailureNotice({
      phaseLabel: "Spec Writing",
      destinationLabel: "Awaiting Info",
      attempts: 3,
      result: failure({ error: 'API Error: 401 {"type":"authentication_error"}' }),
    });
    expect(body).toContain("authenticate");
    expect(body).toContain("every ticket will fail the same way");
    expect(body).toContain("Awaiting Info");
    expect(body).toContain("401");
    expect(body).toContain("```");
  });

  it("renders a generic notice for non-auth failures and notes attempts", () => {
    const body = buildFailureNotice({
      phaseLabel: "Coding",
      destinationLabel: "Blocked",
      attempts: 3,
      result: failure({ error: "TypeError: boom" }),
    });
    expect(body).toContain("Coding");
    expect(body).toContain("after 3 attempts");
    expect(body).toContain("Blocked");
    expect(body).toContain("TypeError: boom");
    expect(body).not.toContain("authenticate");
  });

  it("falls back to the parsed summary when stderr only has an exit code", () => {
    const body = buildFailureNotice({
      phaseLabel: "Coding",
      destinationLabel: "Blocked",
      attempts: 1,
      result: failure({ error: "Exit code 1", summary: "Real reason: 401 unauthorized" }),
    });
    expect(body).toContain("Real reason: 401 unauthorized");
    expect(body).not.toContain("Exit code 1");
    // detected as auth via the summary text
    expect(body).toContain("authenticate");
  });

  it("omits the attempts note for a single attempt", () => {
    const body = buildFailureNotice({
      phaseLabel: "Coding",
      destinationLabel: "Blocked",
      attempts: 1,
      result: failure({ error: "boom" }),
    });
    expect(body).not.toContain("attempts");
  });

  it("sanitizes secrets in the parsed summary before posting", () => {
    const body = buildFailureNotice({
      phaseLabel: "Coding",
      destinationLabel: "Blocked",
      attempts: 1,
      result: failure({ error: "boom", summary: "Authorization: Bearer short-secret" }),
    });
    expect(body).not.toContain("short-secret");
    expect(body).toContain("Bearer <redacted>");
  });

  it("neutralizes code fences in worker output", () => {
    const body = buildFailureNotice({
      phaseLabel: "Coding",
      destinationLabel: "Blocked",
      attempts: 1,
      result: failure({ error: "before ``` after" }),
    });
    // exactly two fences: the open and close of our own block
    expect(body.match(/```/g)?.length).toBe(2);
  });
});
