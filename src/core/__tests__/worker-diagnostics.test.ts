import { describe, expect, it } from "vitest";
import { extractSuccessfulWorkerWarning, sanitizeWorkerDiagnostic } from "../worker-diagnostics.js";

describe("worker diagnostics", () => {
  it("preserves warning-prefixed and effort fallback lines", () => {
    const stderr = [
      "debug: provider initialized",
      "Warning: model setting was ignored",
      "Unknown effort level; falling back to default",
    ].join("\n");

    expect(extractSuccessfulWorkerWarning(stderr)).toBe(
      "Warning: model setting was ignored\nUnknown effort level; falling back to default",
    );
  });

  it("returns undefined for arbitrary successful stderr", () => {
    expect(extractSuccessfulWorkerWarning("plugin chatter\ndebug: request completed")).toBe(
      undefined,
    );
  });

  it("recognizes an effort fallback line naming the codex config key", () => {
    const stderr = "unsupported model_reasoning_effort=ultra; falling back to xhigh";

    expect(extractSuccessfulWorkerWarning(stderr)).toBe(stderr);
  });

  it("redacts credentials, sensitive fields, signed URLs, and long token-like strings", () => {
    const diagnostic = [
      "Authorization: Bearer bearer-value-1234567890",
      "Authorization: Basic dXNlcjpwYXNz",
      "token=short-token api_key: key-value secret='tiny' password=guessme",
      "credential=cred signature=sig sig=azure",
      "https://example.com/file?X-Amz-Signature=signed-value&X-Amz-Credential=user%2Fscope",
      "https://user:password@example.com/file?X-Goog-Signature=goog-signed",
      "opaque ABCDEFGHIJKLMN0PQRSTUVW9",
    ].join("\n");

    const sanitized = sanitizeWorkerDiagnostic(diagnostic);

    expect(sanitized).toContain("Authorization: Bearer <redacted>");
    expect(sanitized).toContain("token=<redacted>");
    expect(sanitized).toContain("api_key: <redacted>");
    expect(sanitized).toContain("X-Amz-Signature=<redacted>");
    expect(sanitized).toContain("X-Amz-Credential=<redacted>");
    expect(sanitized).toContain("X-Goog-Signature=<redacted>");
    expect(sanitized).toContain("https://<redacted>@example.com");
    expect(sanitized).not.toContain("bearer-value-1234567890");
    expect(sanitized).not.toContain("dXNlcjpwYXNz");
    expect(sanitized).not.toContain("guessme");
    expect(sanitized).not.toContain("azure");
    expect(sanitized).not.toContain("ABCDEFGHIJKLMN0PQRSTUVW9");
  });

  it("redacts namespaced sensitive keys below the long-token threshold", () => {
    expect(sanitizeWorkerDiagnostic("DB_PASSWORD=hunter2")).toBe("DB_PASSWORD=<redacted>");
  });

  it("preserves digit-free identifiers and paths", () => {
    const sanitized = sanitizeWorkerDiagnostic(
      "authentication_error opening /Users/justin/projects/redqueen/settings",
    );

    expect(sanitized).toContain("authentication_error");
    expect(sanitized).toContain("/Users/justin/projects/redqueen/settings");
  });

  it("sanitizes a long digit-free token run in bounded time", () => {
    const hostile = "a".repeat(100 * 1024);

    const start = performance.now();
    const sanitized = sanitizeWorkerDiagnostic(hostile);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(2000);
    expect(sanitized).toContain("...[diagnostic truncated]");
  });

  it("caps oversized input before running redaction", () => {
    const oversized = `${"a".repeat(20000)} api_key=secret-value-123`;

    const sanitized = sanitizeWorkerDiagnostic(oversized);

    expect(sanitized.length).toBeLessThan(17000);
    expect(sanitized).toContain("...[diagnostic truncated]");
  });

  it("preserves token-count fields while redacting credential tokens", () => {
    const sanitized = sanitizeWorkerDiagnostic(
      "input_tokens: 5000 output_tokens=12345 access_token: 12345 api_tokens=8f3a9c1d",
    );

    expect(sanitized).toContain("input_tokens: 5000");
    expect(sanitized).toContain("output_tokens=12345");
    expect(sanitized).toContain("access_token: <redacted>");
    expect(sanitized).toContain("api_tokens=<redacted>");
  });

  it("strips ANSI sequences and controls while normalizing whitespace", () => {
    const diagnostic = "\u001b[31mWarning:\u001b[0m bad\u0000thing\t here\r\nnext\u0085line";

    expect(sanitizeWorkerDiagnostic(diagnostic)).toBe("Warning: badthing here\nnextline");
    expect(extractSuccessfulWorkerWarning(diagnostic)).toBe("Warning: badthing here");
  });
});
