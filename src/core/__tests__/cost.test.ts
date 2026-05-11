import { afterEach, describe, expect, it, vi } from "vitest";
import { computeCost, DEFAULT_PRICING, resolvePricing, __resetCostWarnings } from "../cost.js";
import type { RunUsage } from "../types.js";

const noUsage: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

describe("computeCost", () => {
  afterEach(() => {
    __resetCostWarnings();
    vi.restoreAllMocks();
  });

  it("applies default opus pricing", () => {
    // 1M input + 500k output + 2M cache read + 100k cache write
    const usage: RunUsage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 2_000_000,
      cacheCreationTokens: 100_000,
    };
    const cost = computeCost(usage, "opus", {});
    const opus = DEFAULT_PRICING.opus;
    const expected =
      opus.input * 1 + opus.output * 0.5 + opus.cacheRead * 2 + opus.cacheCreation * 0.1;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("zero usage returns zero cost", () => {
    expect(computeCost(noUsage, "opus", {})).toBe(0);
  });

  it("overrides shadow defaults per-key", () => {
    const overrides = {
      opus: { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 },
    };
    const usage: RunUsage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    };
    expect(computeCost(usage, "opus", overrides)).toBeCloseTo(4, 6);
  });

  it("unknown model returns 0 and warns once", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const usage: RunUsage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    expect(computeCost(usage, "mystery-model", {})).toBe(0);
    expect(computeCost(usage, "mystery-model", {})).toBe(0);
    // Warning only emitted once per model to avoid log floods
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("full-id lookup matches alias lookup", () => {
    const usage: RunUsage = {
      inputTokens: 123_456,
      outputTokens: 78_901,
      cacheReadTokens: 10_000,
      cacheCreationTokens: 2_000,
    };
    expect(computeCost(usage, "opus", {})).toBeCloseTo(
      computeCost(usage, "claude-opus-4-7", {}),
      8,
    );
    expect(computeCost(usage, "sonnet", {})).toBeCloseTo(
      computeCost(usage, "claude-sonnet-4-6", {}),
      8,
    );
  });
});

describe("resolvePricing", () => {
  it("returns override before default", () => {
    const override = { input: 99, output: 99, cacheRead: 99, cacheCreation: 99 };
    expect(resolvePricing("opus", { opus: override })).toEqual(override);
  });

  it("falls back to defaults when no override present", () => {
    expect(resolvePricing("opus", {})).toEqual(DEFAULT_PRICING.opus);
  });

  it("returns null for unknown model", () => {
    expect(resolvePricing("nope", {})).toBeNull();
  });
});
