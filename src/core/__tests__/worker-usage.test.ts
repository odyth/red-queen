import { describe, expect, it } from "vitest";
import { extractWorkerOutput, parseCodexOutput } from "../worker.js";

describe("extractWorkerOutput", () => {
  it("extracts summary, usage, and reported cost from well-formed Claude Code JSON output", () => {
    const stdout = JSON.stringify({
      result: "Did the thing.",
      total_cost_usd: 0.05041775,
      usage: {
        input_tokens: 1234,
        output_tokens: 567,
        cache_read_input_tokens: 8900,
        cache_creation_input_tokens: 100,
      },
    });
    const { summary, usage, reportedCostUsd } = extractWorkerOutput(stdout);
    expect(summary).toBe("Did the thing.");
    expect(usage).toEqual({
      inputTokens: 1234,
      outputTokens: 567,
      cacheReadTokens: 8900,
      cacheCreationTokens: 100,
    });
    expect(reportedCostUsd).toBe(0.05041775);
  });

  it("returns null reportedCostUsd when total_cost_usd is absent", () => {
    const stdout = JSON.stringify({
      result: "ok",
      usage: { input_tokens: 5 },
    });
    const { reportedCostUsd } = extractWorkerOutput(stdout);
    expect(reportedCostUsd).toBeNull();
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

function codexLine(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

describe("parseCodexOutput", () => {
  it("extracts the final agent message and mapped usage from a full event stream", () => {
    const stdout = [
      codexLine({ type: "thread.started", thread_id: "th_1" }),
      codexLine({ type: "turn.started" }),
      codexLine({
        type: "item.completed",
        item: { id: "item_1", type: "reasoning", text: "Considering approach" },
      }),
      codexLine({
        type: "item.completed",
        item: { id: "item_2", type: "command_execution", command: "npm test" },
      }),
      codexLine({
        type: "item.completed",
        item: { id: "item_3", type: "agent_message", text: "All tests pass, shipped it." },
      }),
      codexLine({
        type: "turn.completed",
        usage: { input_tokens: 5000, cached_input_tokens: 3000, output_tokens: 900 },
      }),
    ].join("\n");
    const { summary, usage, reportedCostUsd } = parseCodexOutput(stdout);
    expect(summary).toBe("All tests pass, shipped it.");
    // Codex input_tokens includes cached reads; RunUsage separates them.
    expect(usage).toEqual({
      inputTokens: 2000,
      outputTokens: 900,
      cacheReadTokens: 3000,
      cacheCreationTokens: 0,
    });
    expect(reportedCostUsd).toBeNull();
  });

  it("uses the last agent message when there are several", () => {
    const stdout = [
      codexLine({
        type: "item.completed",
        item: { id: "1", type: "agent_message", text: "first" },
      }),
      codexLine({ type: "item.completed", item: { id: "2", type: "agent_message", text: "last" } }),
    ].join("\n");
    expect(parseCodexOutput(stdout).summary).toBe("last");
  });

  it("uses the last turn.completed usage when there are several turns", () => {
    const stdout = [
      codexLine({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 },
      }),
      codexLine({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 },
      }),
    ].join("\n");
    expect(parseCodexOutput(stdout).usage).toEqual({
      inputTokens: 60,
      outputTokens: 7,
      cacheReadTokens: 40,
      cacheCreationTokens: 0,
    });
  });

  it("skips unparseable lines and still finds events", () => {
    const stdout = [
      "garbage not json",
      codexLine({ type: "item.completed", item: { id: "1", type: "agent_message", text: "ok" } }),
      "...[output truncated]...",
    ].join("\n");
    const { summary } = parseCodexOutput(stdout);
    expect(summary).toBe("ok");
  });

  it("falls back to raw stdout when no agent message is present", () => {
    const stdout = "plain codex chatter";
    const { summary, usage } = parseCodexOutput(stdout);
    expect(summary).toBe("plain codex chatter");
    expect(usage).toBeNull();
  });

  it("handles empty stdout without throwing", () => {
    const { summary, usage } = parseCodexOutput("");
    expect(usage).toBeNull();
    expect(summary).toContain("no output");
  });
});
