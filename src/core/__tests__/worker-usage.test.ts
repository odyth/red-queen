import { describe, expect, it } from "vitest";
import { extractWorkerOutput } from "../worker.js";

describe("extractWorkerOutput", () => {
  it("extracts summary and usage from well-formed Claude Code JSON output", () => {
    const stdout = JSON.stringify({
      result: "Did the thing.",
      usage: {
        input_tokens: 1234,
        output_tokens: 567,
        cache_read_input_tokens: 8900,
        cache_creation_input_tokens: 100,
      },
    });
    const { summary, usage } = extractWorkerOutput(stdout);
    expect(summary).toBe("Did the thing.");
    expect(usage).toEqual({
      inputTokens: 1234,
      outputTokens: 567,
      cacheReadTokens: 8900,
      cacheCreationTokens: 100,
    });
  });

  it("returns null usage when the JSON has no usage block", () => {
    const stdout = JSON.stringify({ result: "ok" });
    const { usage } = extractWorkerOutput(stdout);
    expect(usage).toBeNull();
  });

  it("returns null usage and falls back to raw summary for non-JSON output", () => {
    const stdout = "not json at all";
    const { summary, usage } = extractWorkerOutput(stdout);
    expect(usage).toBeNull();
    expect(summary).toBe("not json at all");
  });

  it("handles empty stdout without throwing", () => {
    const { summary, usage } = extractWorkerOutput("");
    expect(usage).toBeNull();
    expect(summary).toContain("no output");
  });

  it("fills missing usage fields with 0 when some are present", () => {
    const stdout = JSON.stringify({
      result: "x",
      usage: { input_tokens: 5 },
    });
    const { usage } = extractWorkerOutput(stdout);
    expect(usage).toEqual({
      inputTokens: 5,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});
