import { describe, it, expect } from "vitest";
import {
  AdapterError,
  AuthError,
  classifyHttpResponse,
  classifyNetworkError,
  redactSecrets,
  withRetry,
} from "../retry.js";

function mkResponse(
  status: number,
  headers: Record<string, string> = {},
): {
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
} {
  return {
    status,
    statusText: "",
    headers: {
      get(name: string): string | null {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  };
}

describe("classifyHttpResponse", () => {
  it("marks 2xx as success", () => {
    const c = classifyHttpResponse(mkResponse(200), null);
    expect(c.kind).toBe("success");
  });

  it("marks 401 as auth", () => {
    const c = classifyHttpResponse(mkResponse(401), null);
    expect(c.kind).toBe("auth");
  });

  it("marks 403 as auth", () => {
    const c = classifyHttpResponse(mkResponse(403), null);
    expect(c.kind).toBe("auth");
  });

  it("marks 429 as retry with Retry-After seconds", () => {
    const c = classifyHttpResponse(mkResponse(429, { "retry-after": "2" }), null);
    expect(c.kind).toBe("retry");
    expect(c.retryAfterMs).toBe(2000);
  });

  it("caps retry-after at 60s", () => {
    const c = classifyHttpResponse(mkResponse(429, { "retry-after": "9999" }), null);
    expect(c.retryAfterMs).toBe(60_000);
  });

  it("marks 500-599 as retry", () => {
    const c500 = classifyHttpResponse(mkResponse(500), null);
    expect(c500.kind).toBe("retry");
    const c503 = classifyHttpResponse(mkResponse(503), null);
    expect(c503.kind).toBe("retry");
  });

  it("marks 400/404 as fatal", () => {
    const c = classifyHttpResponse(mkResponse(404), "not found");
    expect(c.kind).toBe("fatal");
    expect(c.reason).toContain("404");
  });
});

describe("classifyNetworkError", () => {
  it("classifies AuthError as auth", () => {
    const c = classifyNetworkError(new AuthError("bad"));
    expect(c.kind).toBe("auth");
  });

  it("classifies AdapterError as fatal", () => {
    const c = classifyNetworkError(new AdapterError("bad"));
    expect(c.kind).toBe("fatal");
  });

  it("classifies fetch-failed style errors as retry", () => {
    const c = classifyNetworkError(new Error("fetch failed"));
    expect(c.kind).toBe("retry");
  });

  it("classifies ECONNRESET as retry", () => {
    const c = classifyNetworkError(new Error("ECONNRESET on socket"));
    expect(c.kind).toBe("retry");
  });
});

describe("withRetry", () => {
  it("returns success immediately", async () => {
    const result = await withRetry(() => Promise.resolve("ok"), {
      classify: () => ({ kind: "success" }),
      sleep: () => Promise.resolve(),
    });
    expect(result).toBe("ok");
  });

  it("retries and then succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts++;
        if (attempts < 3) {
          return Promise.resolve({ ok: false });
        }
        return Promise.resolve({ ok: true });
      },
      {
        classify: (o) => {
          if (o.kind === "result") {
            const v = o.value as { ok: boolean };
            return v.ok ? { kind: "success" } : { kind: "retry", reason: "not ok" };
          }
          return { kind: "retry", reason: "error" };
        },
        sleep: () => Promise.resolve(),
        baseBackoffMs: 1,
      },
    );
    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it("throws on auth classification without retry", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          throw new AuthError("bad creds");
        },
        {
          classify: () => ({ kind: "auth", reason: "bad creds" }),
          sleep: () => Promise.resolve(),
        },
      ),
    ).rejects.toBeInstanceOf(AuthError);
    expect(attempts).toBe(1);
  });

  it("throws on fatal classification without retry", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          throw new AdapterError("nope");
        },
        {
          classify: () => ({ kind: "fatal", reason: "nope" }),
          sleep: () => Promise.resolve(),
        },
      ),
    ).rejects.toBeInstanceOf(AdapterError);
    expect(attempts).toBe(1);
  });

  it("caps retries at maxRetries", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          return Promise.resolve({ ok: false });
        },
        {
          classify: () => ({ kind: "retry", reason: "flap" }),
          sleep: () => Promise.resolve(),
          maxRetries: 2,
          baseBackoffMs: 1,
        },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(attempts).toBe(3);
  });

  it("stops when budget exhausted", async () => {
    let attempts = 0;
    let now = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          return Promise.resolve({ ok: false });
        },
        {
          classify: () => ({ kind: "retry", reason: "flap" }),
          sleep: (ms) => {
            now += ms;
            return Promise.resolve();
          },
          now: () => now,
          maxRetries: 10,
          baseBackoffMs: 100,
          budgetMs: 150,
        },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(attempts).toBeLessThanOrEqual(3);
  });

  it("honors retryAfterMs over exponential backoff", async () => {
    const delays: number[] = [];
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          return Promise.resolve({ ok: false });
        },
        {
          classify: () => ({ kind: "retry", retryAfterMs: 7, reason: "rate limited" }),
          sleep: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
          maxRetries: 2,
          baseBackoffMs: 1000,
        },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(attempts).toBe(3);
    expect(delays.every((d) => d === 7)).toBe(true);
  });
});

describe("redactSecrets", () => {
  it("replaces long token-like strings", () => {
    const out = redactSecrets("token=ABCDEFGHIJKLMNOPQRSTUVWX say=hi");
    expect(out).toContain("<redacted>");
    expect(out).toContain("say=hi");
  });

  it("leaves short words alone", () => {
    const out = redactSecrets("hello world");
    expect(out).toBe("hello world");
  });
});
