import { describe, it, expect } from "vitest";
import { AuthError } from "../../http/retry.js";
import { JiraClient } from "../client.js";

type FetchFn = typeof fetch;

function toUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function scriptFetch(scripts: { url?: RegExp; response: Response | Error }[]): {
  fetchImpl: FetchFn;
  calls: string[];
} {
  let i = 0;
  const calls: string[] = [];
  const fetchImpl: FetchFn = ((input: RequestInfo | URL) => {
    const url = toUrlString(input);
    calls.push(url);
    const script = scripts[i++];
    if (script === undefined) {
      return Promise.reject(new Error(`Unexpected fetch call #${String(i)}: ${url}`));
    }
    if (script.url?.test(url) === false) {
      return Promise.reject(
        new Error(`URL mismatch: expected ${script.url.toString()}, got ${url}`),
      );
    }
    if (script.response instanceof Error) {
      return Promise.reject(script.response);
    }
    return Promise.resolve(script.response);
  }) as FetchFn;
  return { fetchImpl, calls };
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const init: ResponseInit = {
    status,
    headers: { "content-type": "application/json", ...headers },
  };
  return new Response(typeof body === "string" ? body : JSON.stringify(body), init);
}

describe("JiraClient", () => {
  const baseOptions = {
    baseUrl: "https://example.atlassian.net",
    email: "a@b.com",
    apiToken: "token",
  };

  it("returns JSON on 200", async () => {
    const { fetchImpl } = scriptFetch([{ response: response(200, { ok: true }) }]);
    const client = new JiraClient({ ...baseOptions, fetchImpl });
    const result = await client.request<{ ok: boolean }>("GET", "/rest/api/3/myself");
    expect(result).toEqual({ ok: true });
  });

  it("sends basic auth header", async () => {
    let capturedAuth: string | null = null;
    const fetchImpl: FetchFn = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth = headers?.Authorization ?? null;
      return Promise.resolve(response(200, {}));
    }) as FetchFn;
    const client = new JiraClient({ ...baseOptions, fetchImpl });
    await client.request("GET", "/a");
    expect(capturedAuth).toContain("Basic ");
  });

  it("retries 429 with Retry-After", async () => {
    const { fetchImpl } = scriptFetch([
      { response: response(429, {}, { "retry-after": "1" }) },
      { response: response(200, { ok: true }) },
    ]);
    const client = new JiraClient({
      ...baseOptions,
      fetchImpl,
      sleep: () => Promise.resolve(),
    });
    const result = await client.request<{ ok: boolean }>("GET", "/a");
    expect(result.ok).toBe(true);
  });

  it("retries 5xx with exponential backoff", async () => {
    const { fetchImpl } = scriptFetch([
      { response: response(503, {}) },
      { response: response(502, {}) },
      { response: response(200, { ok: true }) },
    ]);
    const client = new JiraClient({
      ...baseOptions,
      fetchImpl,
      sleep: () => Promise.resolve(),
    });
    const result = await client.request<{ ok: boolean }>("GET", "/a");
    expect(result.ok).toBe(true);
  });

  it("throws AuthError on 401", async () => {
    const { fetchImpl } = scriptFetch([{ response: response(401, { message: "bad" }) }]);
    const client = new JiraClient({ ...baseOptions, fetchImpl });
    await expect(client.request("GET", "/a")).rejects.toBeInstanceOf(AuthError);
  });

  it("throws on persistent 4xx", async () => {
    const { fetchImpl } = scriptFetch([{ response: response(404, { message: "missing" }) }]);
    const client = new JiraClient({ ...baseOptions, fetchImpl });
    await expect(client.request("GET", "/a")).rejects.toBeInstanceOf(Error);
  });

  it("retries transient network errors", async () => {
    const { fetchImpl } = scriptFetch([
      { response: new Error("fetch failed") },
      { response: response(200, { ok: true }) },
    ]);
    const client = new JiraClient({
      ...baseOptions,
      fetchImpl,
      sleep: () => Promise.resolve(),
    });
    const result = await client.request<{ ok: boolean }>("GET", "/a");
    expect(result.ok).toBe(true);
  });

  it("handles 204 No Content", async () => {
    const { fetchImpl } = scriptFetch([{ response: new Response(null, { status: 204 }) }]);
    const client = new JiraClient({ ...baseOptions, fetchImpl });
    const result = await client.request("PUT", "/a", { x: 1 });
    expect(result).toBeUndefined();
  });
});
