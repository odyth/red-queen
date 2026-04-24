import {
  AdapterError,
  AuthError,
  classifyHttpResponse,
  classifyNetworkError,
  withRetry,
} from "../http/retry.js";
import type { RetryClassification } from "../http/retry.js";

export interface JiraClientOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { url: string; attempt: number; reason: string; delayMs: number }) => void;
  userAgent?: string;
}

export class JiraClient {
  readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry:
    | ((info: { url: string; attempt: number; reason: string; delayMs: number }) => void)
    | null;
  private readonly userAgent: string;

  constructor(options: JiraClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.authHeader = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString("base64")}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep =
      options.sleep ??
      ((ms: number): Promise<void> =>
        new Promise((res) => {
          setTimeout(res, ms);
        }));
    this.onRetry = options.onRetry ?? null;
    this.userAgent = options.userAgent ?? "red-queen/0.1.0";
  }

  get authorization(): string {
    return this.authHeader;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return withRetry(
      async () => {
        const response = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: this.authHeader,
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (response.ok === false) {
          const bodyText = await response.text().catch(() => "");
          throw new HttpAttemptError(response.status, response.statusText, bodyText, url, {
            "retry-after": response.headers.get("retry-after"),
            "x-ratelimit-reset": response.headers.get("x-ratelimit-reset"),
          });
        }
        if (response.status === 204) {
          return undefined as unknown as T;
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          return (await response.json()) as T;
        }
        return (await response.text()) as unknown as T;
      },
      {
        classify: (outcome): RetryClassification => {
          if (outcome.kind === "result") {
            return { kind: "success" };
          }
          return classifyJiraError(outcome.error);
        },
        sleep: this.sleep,
        onAttempt: (info) => {
          if (this.onRetry !== null) {
            this.onRetry({
              url: `${method} ${path}`,
              attempt: info.attempt,
              reason: info.reason,
              delayMs: info.delayMs,
            });
          }
        },
      },
    );
  }

  async getRaw(path: string): Promise<{ status: number; body: string }> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "User-Agent": this.userAgent,
      },
    });
    const bodyText = await response.text().catch(() => "");
    return { status: response.status, body: bodyText };
  }

  async pingMyself<T>(): Promise<T> {
    return this.request<T>("GET", "/rest/api/3/myself");
  }
}

class HttpAttemptError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly bodyText: string;
  readonly url: string;
  readonly headers: Record<string, string | null>;

  constructor(
    status: number,
    statusText: string,
    bodyText: string,
    url: string,
    headers: Record<string, string | null>,
  ) {
    super(`HTTP ${String(status)} ${statusText} at ${url}`);
    this.name = "HttpAttemptError";
    this.status = status;
    this.statusText = statusText;
    this.bodyText = bodyText;
    this.url = url;
    this.headers = headers;
  }
}

function classifyJiraError(error: unknown): RetryClassification {
  if (error instanceof AuthError) {
    return { kind: "auth", reason: error.message };
  }
  if (error instanceof AdapterError) {
    return { kind: "fatal", reason: error.message };
  }
  if (error instanceof HttpAttemptError) {
    const fakeResponse = {
      status: error.status,
      statusText: error.statusText,
      headers: {
        get(name: string): string | null {
          return error.headers[name.toLowerCase()] ?? null;
        },
      },
    };
    const classification = classifyHttpResponse(fakeResponse, error.bodyText);
    if (classification.kind === "auth") {
      throw new AuthError(classification.reason ?? "Jira auth failed", {
        status: error.status,
        url: error.url,
        bodyText: error.bodyText,
      });
    }
    if (classification.kind === "fatal") {
      throw new AdapterError(
        `Jira ${classification.reason ?? ""}: ${truncate(error.bodyText, 300)}`.trim(),
        { status: error.status, url: error.url, bodyText: error.bodyText },
      );
    }
    return classification;
  }
  return classifyNetworkError(error);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
