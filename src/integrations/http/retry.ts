export class AdapterError extends Error {
  readonly status: number | null;
  readonly url: string | null;
  readonly bodyText: string | null;

  constructor(
    message: string,
    options: { status?: number | null; url?: string | null; bodyText?: string | null } = {},
  ) {
    super(message);
    this.name = "AdapterError";
    this.status = options.status ?? null;
    this.url = options.url ?? null;
    this.bodyText = options.bodyText ?? null;
  }
}

export class AuthError extends AdapterError {
  constructor(
    message: string,
    options: { status?: number | null; url?: string | null; bodyText?: string | null } = {},
  ) {
    super(message, options);
    this.name = "AuthError";
  }
}

export interface RetryClassification {
  kind: "success" | "retry" | "auth" | "fatal";
  retryAfterMs?: number;
  reason?: string;
}

export interface WithRetryOptions {
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  budgetMs?: number;
  classify: (outcome: RetryOutcome) => RetryClassification;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onAttempt?: (info: { attempt: number; reason: string; delayMs: number }) => void;
}

export type RetryOutcome = { kind: "result"; value: unknown } | { kind: "error"; error: unknown };

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_BUDGET_MS = 120_000;

export async function withRetry<T>(fn: () => Promise<T>, opts: WithRetryOptions): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseBackoff = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxBackoff = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const sleep =
    opts.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((res) => {
        setTimeout(res, ms);
      }));
  const now = opts.now ?? ((): number => Date.now());

  const start = now();
  let attempt = 0;
  let lastError: unknown;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    let outcome: RetryOutcome;
    try {
      const value = await fn();
      outcome = { kind: "result", value };
    } catch (error) {
      outcome = { kind: "error", error };
    }

    const classification = opts.classify(outcome);

    if (classification.kind === "success" && outcome.kind === "result") {
      return outcome.value as T;
    }

    if (classification.kind === "auth" || classification.kind === "fatal") {
      if (outcome.kind === "error") {
        throw outcome.error;
      }
      throw new AdapterError(classification.reason ?? "Adapter call failed");
    }

    // retry path
    lastError =
      outcome.kind === "error"
        ? outcome.error
        : new AdapterError(classification.reason ?? "Adapter call returned retryable response");

    if (attempt >= maxRetries) {
      throw lastError;
    }

    const elapsedMs = now() - start;
    const remainingBudget = budget - elapsedMs;
    if (remainingBudget <= 0) {
      throw lastError;
    }

    const exponentialDelay = Math.min(maxBackoff, baseBackoff * 2 ** attempt);
    const classificationDelay = classification.retryAfterMs ?? exponentialDelay;
    const delay = Math.min(classificationDelay, maxBackoff, remainingBudget);

    if (opts.onAttempt) {
      opts.onAttempt({
        attempt: attempt + 1,
        reason: classification.reason ?? "retry",
        delayMs: delay,
      });
    }

    if (delay > 0) {
      await sleep(delay);
    }
    attempt++;
  }
}

export interface HttpResponseLike {
  status: number;
  statusText?: string;
  headers: { get(name: string): string | null };
  text?: () => Promise<string>;
}

export function classifyHttpResponse(
  response: HttpResponseLike,
  bodyText: string | null,
): RetryClassification {
  const { status } = response;
  if (status >= 200 && status < 300) {
    return { kind: "success" };
  }
  if (status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const resetHeader = response.headers.get("x-ratelimit-reset");
    const retryMs = parseRetryAfter(retryAfter) ?? parseRateLimitReset(resetHeader);
    return {
      kind: "retry",
      retryAfterMs: retryMs,
      reason: `HTTP 429 rate limited`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      reason: `HTTP ${String(status)} — authentication failed. Check your tokens.`,
    };
  }
  if (status >= 500 && status < 600) {
    return {
      kind: "retry",
      reason: `HTTP ${String(status)} ${response.statusText ?? "server error"}`,
    };
  }
  return {
    kind: "fatal",
    reason: `HTTP ${String(status)} ${response.statusText ?? ""} ${bodyText ?? ""}`.trim(),
  };
}

export function classifyNetworkError(error: unknown): RetryClassification {
  if (error instanceof AuthError) {
    return { kind: "auth", reason: error.message };
  }
  if (error instanceof AdapterError) {
    return { kind: "fatal", reason: error.message };
  }
  if (error instanceof Error) {
    const msg = error.message;
    if (isTransientNetworkError(msg)) {
      return { kind: "retry", reason: `network: ${msg}` };
    }
  }
  return { kind: "retry", reason: `network error` };
}

function isTransientNetworkError(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("econnreset") ||
    lowered.includes("etimedout") ||
    lowered.includes("econnrefused") ||
    lowered.includes("enotfound") ||
    lowered.includes("socket") ||
    lowered.includes("network") ||
    lowered.includes("fetch failed") ||
    lowered.includes("other side closed")
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.min(60_000, asNumber * 1000);
  }
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    if (delta > 0) {
      return Math.min(60_000, delta);
    }
  }
  return undefined;
}

function parseRateLimitReset(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const resetSec = Number(value);
  if (Number.isFinite(resetSec) === false) {
    return undefined;
  }
  const delta = resetSec * 1000 - Date.now();
  if (delta <= 0) {
    return undefined;
  }
  return Math.min(60_000, delta);
}

export function redactSecrets(input: string): string {
  return input.replace(/[A-Za-z0-9+/=_-]{20,}/g, "<redacted>");
}
