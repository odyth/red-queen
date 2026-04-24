import { Octokit } from "@octokit/rest";
import { AdapterError, AuthError, redactSecrets, withRetry } from "../http/retry.js";
import type { RetryClassification } from "../http/retry.js";
import type { GitHubAuthStrategy } from "./auth.js";

export interface GitHubClientOptions {
  auth: GitHubAuthStrategy;
  userAgent?: string;
  onRetry?: (info: { url: string; attempt: number; reason: string; delayMs: number }) => void;
  sleep?: (ms: number) => Promise<void>;
  octokit?: Octokit;
  apiBase?: string;
}

interface OctokitRequestError extends Error {
  status?: number;
  response?: { headers?: Record<string, string | number | undefined>; data?: unknown };
  request?: { url?: string };
}

export class GitHubClient {
  readonly octokit: Octokit;
  readonly auth: GitHubAuthStrategy;
  private readonly onRetry:
    | ((info: { url: string; attempt: number; reason: string; delayMs: number }) => void)
    | null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GitHubClientOptions) {
    this.auth = options.auth;
    this.octokit = options.octokit ?? buildOctokit(options);
    this.onRetry = options.onRetry ?? null;
    this.sleep =
      options.sleep ??
      ((ms: number): Promise<void> =>
        new Promise((res) => {
          setTimeout(res, ms);
        }));
  }

  get rest(): Octokit["rest"] {
    return this.octokit.rest;
  }

  async call<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      classify: (outcome): RetryClassification => {
        if (outcome.kind === "result") {
          return { kind: "success" };
        }
        return classifyOctokitError(outcome.error);
      },
      sleep: this.sleep,
      onAttempt: (info) => {
        if (this.onRetry !== null) {
          this.onRetry({
            url: label,
            attempt: info.attempt,
            reason: info.reason,
            delayMs: info.delayMs,
          });
        }
      },
    });
  }

  get paginate(): Octokit["paginate"] {
    return this.octokit.paginate.bind(this.octokit);
  }
}

function buildOctokit(options: GitHubClientOptions): Octokit {
  return new Octokit({
    authStrategy: (): {
      hook: (
        request: (opts: Record<string, unknown>) => Promise<unknown>,
        route: string | Record<string, unknown>,
        parameters?: Record<string, unknown>,
      ) => Promise<unknown>;
    } => ({
      hook: async (request, route, parameters) => {
        const token = await options.auth.getToken();
        const endpointOptions =
          typeof route === "string"
            ? { ...(parameters ?? {}), url: route }
            : { ...route, ...(parameters ?? {}) };
        const merged = {
          ...endpointOptions,
          headers: {
            ...((endpointOptions as { headers?: Record<string, unknown> }).headers ?? {}),
            authorization: `token ${token}`,
          },
        };
        return request(merged);
      },
    }),
    userAgent: options.userAgent ?? "red-queen/0.1.0",
    request: { retries: 0 },
    baseUrl: options.apiBase,
  });
}

export function classifyOctokitError(error: unknown): RetryClassification {
  if (error instanceof AuthError) {
    return { kind: "auth", reason: error.message };
  }
  if (error instanceof AdapterError) {
    return { kind: "fatal", reason: error.message };
  }
  const err = error as OctokitRequestError;
  const status = typeof err.status === "number" ? err.status : null;
  if (status === null) {
    const message = err.message;
    if (isTransientNetworkMessage(message)) {
      return { kind: "retry", reason: `network: ${message}` };
    }
    return { kind: "fatal", reason: `GitHub error: ${message}` };
  }
  if (status >= 200 && status < 300) {
    return { kind: "success" };
  }
  if (status === 401 || status === 403) {
    const remaining = readHeaderNumber(err.response?.headers, "x-ratelimit-remaining");
    if (status === 403 && remaining === 0) {
      return {
        kind: "retry",
        retryAfterMs: rateLimitDelayMs(err.response?.headers),
        reason: "GitHub rate limit exhausted",
      };
    }
    throw new AuthError(`GitHub auth failed (HTTP ${String(status)}).`, { status });
  }
  if (status === 429) {
    return {
      kind: "retry",
      retryAfterMs:
        parseHeaderSeconds(err.response?.headers, "retry-after") ??
        rateLimitDelayMs(err.response?.headers),
      reason: "GitHub HTTP 429 rate limited",
    };
  }
  if (status >= 500 && status < 600) {
    return { kind: "retry", reason: `GitHub HTTP ${String(status)}` };
  }
  const body = serializeBody(err.response?.data);
  return {
    kind: "fatal",
    reason: `GitHub HTTP ${String(status)} ${body}`.trim(),
  };
}

function isTransientNetworkMessage(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("econnreset") ||
    lowered.includes("etimedout") ||
    lowered.includes("enotfound") ||
    lowered.includes("econnrefused") ||
    lowered.includes("network") ||
    lowered.includes("socket hang up") ||
    lowered.includes("fetch failed")
  );
}

function readHeaderNumber(
  headers: Record<string, string | number | undefined> | undefined,
  key: string,
): number | null {
  if (headers === undefined) {
    return null;
  }
  const value = headers[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseHeaderSeconds(
  headers: Record<string, string | number | undefined> | undefined,
  key: string,
): number | undefined {
  const n = readHeaderNumber(headers, key);
  if (n === null) {
    return undefined;
  }
  return Math.min(60_000, Math.max(0, n * 1000));
}

function rateLimitDelayMs(
  headers: Record<string, string | number | undefined> | undefined,
): number | undefined {
  const reset = readHeaderNumber(headers, "x-ratelimit-reset");
  if (reset === null) {
    return undefined;
  }
  const delta = reset * 1000 - Date.now();
  if (delta <= 0) {
    return undefined;
  }
  return Math.min(60_000, delta);
}

function serializeBody(data: unknown): string {
  if (data === undefined || data === null) {
    return "";
  }
  if (typeof data === "string") {
    return redactSecrets(data.slice(0, 300));
  }
  try {
    return redactSecrets(JSON.stringify(data).slice(0, 300));
  } catch {
    return "<unserializable>";
  }
}
