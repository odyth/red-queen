import type { CostBreakdown, PhaseCostRow } from "./types.js";

export function renderBreakdownMarkdown(breakdown: CostBreakdown): string {
  const lines: string[] = [];
  lines.push(`**Cost summary** (model: ${breakdown.model})`);
  lines.push("");
  lines.push("| Phase | Iterations | Input | Output | Cache read | Cache write | Cost |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  if (breakdown.phases.length === 0) {
    lines.push("| _(no phases recorded)_ | | | | | | |");
  } else {
    for (const row of breakdown.phases) {
      lines.push(renderRow(row));
    }
  }
  lines.push(`| **Total** | | | | | | **${formatUsd(breakdown.totalCostUsd)}** |`);
  lines.push("");
  lines.push(`_Updated ${breakdown.updatedAt}_`);
  return lines.join("\n");
}

function renderRow(row: PhaseCostRow): string {
  return [
    row.phase,
    String(row.iterations),
    formatTokens(row.usage.inputTokens),
    formatTokens(row.usage.outputTokens),
    formatTokens(row.usage.cacheReadTokens),
    formatTokens(row.usage.cacheCreationTokens),
    formatUsd(row.costUsd),
  ]
    .map((cell) => ` ${cell} `)
    .join("|")
    .replace(/^/, "|")
    .concat("|");
}

function formatTokens(n: number): string {
  if (n === 0) {
    return "0";
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

export function formatUsd(n: number): string {
  if (n < 0.01 && n > 0) {
    return `<$0.01`;
  }
  return `$${n.toFixed(2)}`;
}
