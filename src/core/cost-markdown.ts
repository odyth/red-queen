import type { CostBreakdown, PhaseCostRow } from "./types.js";
import { COST_DISCLAIMER, formatTokens, formatUsd } from "./cost-format.js";

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
  lines.push(`_${COST_DISCLAIMER}_`);
  lines.push(`_Updated ${breakdown.updatedAt}_`);
  return lines.join("\n");
}

function renderRow(row: PhaseCostRow): string {
  const cells = [
    row.phase,
    String(row.iterations),
    formatTokens(row.usage.inputTokens),
    formatTokens(row.usage.outputTokens),
    formatTokens(row.usage.cacheReadTokens),
    formatTokens(row.usage.cacheCreationTokens),
    formatUsd(row.costUsd),
  ];
  return `| ${cells.join(" | ")} |`;
}
