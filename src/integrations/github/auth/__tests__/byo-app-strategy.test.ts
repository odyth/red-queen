import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { AdapterError, AuthError } from "../../../http/retry.js";
import { ByoAppAuthStrategy } from "../byo-app-strategy.js";

type FetchFn = typeof fetch;

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function makeResponse(status: number, bodyJson: unknown): Response {
  return new Response(JSON.stringify(bodyJson), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function futureIso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

function recordingFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  fn: FetchFn;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn: FetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      const raw = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) {
        headers[k] = v;
      }
    }
    const call: FetchCall = { url, method, headers };
    calls.push(call);
    return handler(call);
  }) as FetchFn;
  return { fn, calls };
}

let pkcs1Pem: string;
let pkcs8Pem: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  pkcs1Pem = privateKey.export({ format: "pem", type: "pkcs1" });
  pkcs8Pem = privateKey.export({ format: "pem", type: "pkcs8" });
});

describe("ByoAppAuthStrategy", () => {
  describe("constructor validation", () => {
    it("throws on empty appId", () => {
      expect(
        () =>
          new ByoAppAuthStrategy({
            appId: "",
            installationId: "789",
            privateKeyPem: pkcs1Pem,
          }),
      ).toThrow(AdapterError);
    });

    it("throws on empty installationId", () => {
      expect(
        () =>
          new ByoAppAuthStrategy({
            appId: "123",
            installationId: "",
            privateKeyPem: pkcs1Pem,
          }),
      ).toThrow(AdapterError);
    });

    it("throws on whitespace-only appId", () => {
      expect(
        () =>
          new ByoAppAuthStrategy({
            appId: "   ",
            installationId: "789",
            privateKeyPem: pkcs1Pem,
          }),
      ).toThrow(AdapterError);
    });

    it("throws on whitespace-only installationId", () => {
      expect(
        () =>
          new ByoAppAuthStrategy({
            appId: "123",
            installationId: "\t\n",
            privateKeyPem: pkcs1Pem,
          }),
      ).toThrow(AdapterError);
    });

    it("throws on non-PEM key", () => {
      expect(
        () =>
          new ByoAppAuthStrategy({
            appId: "123",
            installationId: "789",
            privateKeyPem: "not a pem at all",
          }),
      ).toThrow(AdapterError);
    });
  });

  describe("private key loading", () => {
    it("rejects PEM with unrecognized header (defers to first use)", async () => {
      const bogus = "-----BEGIN GARBAGE-----\nMIIBIjANBgkqhkiG9w0BAQ\n-----END GARBAGE-----\n";
      const { fn } = recordingFetch(() => makeResponse(200, {}));
      const strategy = new ByoAppAuthStrategy({
        appId: "123",
        installationId: "789",
        privateKeyPem: bogus,
        fetchImpl: fn,
      });
      await expect(strategy.getToken()).rejects.toBeInstanceOf(AdapterError);
    });

    it("loads PKCS#1 key and mints a token", async () => {
      const { fn, calls } = recordingFetch(() =>
        makeResponse(201, { token: "ghs_pkcs1", expires_at: futureIso(60 * 60 * 1000) }),
      );
      const strategy = new ByoAppAuthStrategy({
        appId: "123",
        installationId: "789",
        privateKeyPem: pkcs1Pem,
        fetchImpl: fn,
      });
      expect(await strategy.getToken()).toBe("ghs_pkcs1");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain("/app/installations/789/access_tokens");
    });

    it("loads PKCS#8 key and mints a token", async () => {
      const { fn } = recordingFetch(() =>
        makeResponse(201, { token: "ghs_pkcs8", expires_at: futureIso(60 * 60 * 1000) }),
      );
      const strategy = new ByoAppAuthStrategy({
        appId: "123",
        installationId: "789",
        privateKeyPem: pkcs8Pem,
        fetchImpl: fn,
      });
      expect(await strategy.getToken()).toBe("ghs_pkcs8");
    });
  });

  describe("token minting", () => {
    it("caches the token across calls", async () => {
      const { fn, calls } = recordingFetch(() =>
        makeResponse(201, { token: "ghs_cached", expires_at: futureIso(60 * 60 * 1000) }),
      );
      const strategy = new ByoAppAuthStrategy({
        appId: "123",
        installationId: "789",
        privateKeyPem: pkcs1Pem,
        fetchImpl: fn,
      });
      const t1 = await strategy.getToken();
      const t2 = await strategy.getToken();
      expect(t1).toBe("ghs_cached");
      expect(t2).toBe("ghs_cached");
      expect(calls).toHaveLength(1);
    });

    it("refreshes when within the refresh buffer", async () => {
      let seq = 0;
      const { fn, calls } = recordingFetch(() => {
        seq++;
        return makeResponse(201, {
          token: `ghs_${String(seq)}`,
          // 1 minute from now, within any reasonable refresh buffer.
          expires_at: futureIso(60 * 1000),
        });
      });
      const strategy = new ByoAppAuthStrategy({
        appId: "123",
        installationId: "789",
        privateKeyPem: pkcs1Pem,
        fetchImpl: fn,
        // Refresh buffer larger than the token lifetime → always refresh.
        refreshBufferMs: 5 * 60 * 1000,
      });
      await strategy.getToken();
      await strategy.getToken();
      expect(calls).toHaveLength(2);
    });

    it("single-flight refresh when called in parallel", async () => {
      let resolveFetch: ((r: Response) => void) | null = null;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      const { fn, calls } = recordingFetch(() => fetchPromise);
      const strategy = new ByoAppAuthStrategy({
        appId: "123",
        installationId: "789",
        privateKeyPem: pkcs1Pem,
        fetchImpl: fn,
      });
      const parallel = Array.from({ length: 10 }, () => strategy.getToken());
      // Give microtasks a chance to register.
      await new Promise((r) => setTimeout(r, 0));
      resolveFetch?.(
        makeResponse(201, { token: "ghs_single", expires_at: futureIso(60 * 60 * 1000) }),
      );
      const results = await Promise.all(parallel);
      expect(results.every((t) => t === "ghs_single")).toBe(true);
      expect(calls).toHaveLength(1);
    });

    it("throws AuthError on 401", async () => {
      const { fn } = recordingFetch(() => makeResponse(401, { message: "Bad credentials" }));
      const strategy = new ByoAppAuthStrategy({
        appId: "123",
        installationId: "789",
        privateKeyPem: pkcs1Pem,
        fetchImpl: fn,
      });
      await expect(strategy.getToken()).rejects.toBeInstanceOf(AuthError);
    });

    it("throws AuthError on 403", async () => {
      const { fn } = recordingFetch(() => makeResponse(403, { message: "Forbidden" }));
      const strategy = new ByoAppAuthStrategy({
        appId: "123",
        installationId: "789",
        privateKeyPem: pkcs1Pem,
        fetchImpl: fn,
      });
      await expect(strategy.getToken()).rejects.toBeInstanceOf(AuthError);
    });

    it("throws AuthError on 404 with install-not-found message", async () => {
      const { fn } = recordingFetch(() => makeResponse(404, { message: "Not Found" }));
      const strategy = new ByoAppAuthStrategy({
        appId: "123",
        installationId: "789",
        privateKeyPem: pkcs1Pem,
        fetchImpl: fn,
      });
      const err = await strategy.getToken().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).toContain("installation 789 not found");
    });

    it("throws AdapterError (not AuthError) on 500 with truncated body", async () => {
      const longBody = "x".repeat(500);
      const { fn } = recordingFetch(
        () =>
          new Response(longBody, {
            status: 500,
            headers: { "content-type": "text/plain" },
          }),
      );
      const strategy = new ByoAppAuthStrategy({
        appId: "123",
        installationId: "789",
        privateKeyPem: pkcs1Pem,
        fetchImpl: fn,
      });
      const err = await strategy.getToken().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AdapterError);
      expect(err).not.toBeInstanceOf(AuthError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/HTTP 500/);
      const bodyStart = msg.indexOf(": ") + 2;
      expect(msg.slice(bodyStart).length).toBeLessThanOrEqual(200);
    });
  });

  describe("identity", () => {
    it("returns ${slug}[bot] with isBot true", async () => {
      const { fn } = recordingFetch((call) => {
        if (call.url.endsWith("/app")) {
          return makeResponse(200, { slug: "my-app", id: 12345 });
        }
        throw new Error(`unexpected ${call.url}`);
      });
      const strategy = new ByoAppAuthStrategy({
        appId: "123",
        installationId: "789",
        privateKeyPem: pkcs1Pem,
        fetchImpl: fn,
      });
      const id = await strategy.getIdentity();
      expect(id).toEqual({
        login: "my-app[bot]",
        accountId: "12345",
        isBot: true,
      });
    });

    it("caches identity across calls", async () => {
      const { fn, calls } = recordingFetch(() => makeResponse(200, { slug: "my-app", id: 12345 }));
      const strategy = new ByoAppAuthStrategy({
        appId: "123",
        installationId: "789",
        privateKeyPem: pkcs1Pem,
        fetchImpl: fn,
      });
      const id1 = await strategy.getIdentity();
      const id2 = await strategy.getIdentity();
      expect(id1).toEqual(id2);
      expect(calls).toHaveLength(1);
    });

    it("throws AuthError on identity 401", async () => {
      const { fn } = recordingFetch(() => makeResponse(401, { message: "Bad credentials" }));
      const strategy = new ByoAppAuthStrategy({
        appId: "123",
        installationId: "789",
        privateKeyPem: pkcs1Pem,
        fetchImpl: fn,
      });
      await expect(strategy.getIdentity()).rejects.toBeInstanceOf(AuthError);
    });

    it("throws AdapterError on identity unexpected shape", async () => {
      const { fn } = recordingFetch(() => makeResponse(200, { unexpected: true }));
      const strategy = new ByoAppAuthStrategy({
        appId: "123",
        installationId: "789",
        privateKeyPem: pkcs1Pem,
        fetchImpl: fn,
      });
      await expect(strategy.getIdentity()).rejects.toBeInstanceOf(AdapterError);
    });
  });
});
