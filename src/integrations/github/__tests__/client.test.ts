import { describe, it, expect } from "vitest";
import { AdapterError, AuthError } from "../../http/retry.js";
import { classifyOctokitError } from "../client.js";

function mkOctokitError(
  status: number,
  headers: Record<string, string | number> = {},
  message = "",
  data: unknown = null,
): Error & { status?: number; response?: unknown } {
  const err = new Error(message.length > 0 ? message : `HTTP ${String(status)}`) as Error & {
    status?: number;
    response?: { headers: Record<string, string | number>; data: unknown };
  };
  err.status = status;
  err.response = { headers, data };
  return err;
}

describe("classifyOctokitError", () => {
  it("retries on 500", () => {
    const c = classifyOctokitError(mkOctokitError(500));
    expect(c.kind).toBe("retry");
  });

  it("retries on 429 with retry-after", () => {
    const c = classifyOctokitError(mkOctokitError(429, { "retry-after": "3" }));
    expect(c.kind).toBe("retry");
    expect(c.retryAfterMs).toBe(3000);
  });

  it("throws AuthError for 401", () => {
    expect(() => classifyOctokitError(mkOctokitError(401))).toThrow(AuthError);
  });

  it("treats 403 with rate limit exhaustion as retry", () => {
    const reset = Math.floor(Date.now() / 1000) + 10;
    const c = classifyOctokitError(
      mkOctokitError(403, { "x-ratelimit-remaining": 0, "x-ratelimit-reset": reset }),
    );
    expect(c.kind).toBe("retry");
  });

  it("throws AuthError for plain 403", () => {
    expect(() => classifyOctokitError(mkOctokitError(403))).toThrow(AuthError);
  });

  it("marks 4xx as fatal", () => {
    const c = classifyOctokitError(mkOctokitError(422, {}, "Unprocessable", { error: "bad" }));
    expect(c.kind).toBe("fatal");
    expect(c.reason).toContain("422");
  });

  it("retries transient network errors without status", () => {
    const err = new Error("fetch failed");
    const c = classifyOctokitError(err);
    expect(c.kind).toBe("retry");
  });

  it("passes through AdapterError as fatal", () => {
    const c = classifyOctokitError(new AdapterError("already fatal"));
    expect(c.kind).toBe("fatal");
  });
});
