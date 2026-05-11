import { describe, expect, it } from "vitest";
import { renderBreakdownMarkdown, formatUsd } from "../cost-markdown.js";
import type { CostBreakdown } from "../types.js";

const row = (phase: string, iterations: number, cost: number): CostBreakdown["phases"][number] => ({
  phase,
  iterations,
  usage: {
    inputTokens: 1500,
    outputTokens: 200,
    cacheReadTokens: 3400,
    cacheCreationTokens: 100,
  },
  costUsd: cost,
});

describe("renderBreakdownMarkdown", () => {
  it("renders per-phase rows and a total row", () => {
    const breakdown: CostBreakdown = {
      totalCostUsd: 1.23,
      model: "opus",
      currency: "USD",
      phases: [row("spec-writing", 1, 0.5), row("coding", 2, 0.73)],
      updatedAt: "2026-05-11T12:00:00Z",
    };
    const md = renderBreakdownMarkdown(breakdown);
    expect(md).toContain("spec-writing");
    expect(md).toContain("coding");
    expect(md).toContain("**Total**");
    expect(md).toContain("$1.23");
    expect(md).toMatch(/model: opus/);
    expect(md).toContain("2026-05-11T12:00:00Z");
  });

  it("handles empty breakdown gracefully", () => {
    const breakdown: CostBreakdown = {
      totalCostUsd: 0,
      model: "haiku",
      currency: "USD",
      phases: [],
      updatedAt: "now",
    };
    const md = renderBreakdownMarkdown(breakdown);
    expect(md).toContain("(no phases recorded)");
    expect(md).toContain("$0.00");
  });
});

describe("formatUsd", () => {
  it("formats standard values with two decimals", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(42)).toBe("$42.00");
  });

  it("uses <$0.01 for tiny nonzero costs", () => {
    expect(formatUsd(0.001)).toBe("<$0.01");
  });
});
