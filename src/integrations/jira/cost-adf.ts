import type { AdfDocument, AdfNode } from "./adf.js";
import type { CostBreakdown, PhaseCostRow } from "../../core/types.js";
import { formatTokens, formatUsd } from "../../core/cost-format.js";

// toAdf() doesn't support markdown tables, so running the pipe-table string
// through it produces a wall of hardBreak-separated literals in the Jira
// custom field. Render the ADF table node tree directly instead.

const HEADERS = [
  "Phase",
  "Iterations",
  "Input",
  "Output",
  "Cache read",
  "Cache write",
  "Cost",
] as const;

export function renderBreakdownAdf(breakdown: CostBreakdown): AdfDocument {
  const rows: AdfNode[] = [headerRow()];
  if (breakdown.phases.length === 0) {
    rows.push(emptyRow());
  } else {
    for (const phase of breakdown.phases) {
      rows.push(phaseRow(phase));
    }
  }
  rows.push(totalRow(breakdown.totalCostUsd));

  const table: AdfNode = {
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: rows,
  };

  return {
    type: "doc",
    version: 1,
    content: [
      paragraph([
        textNode("Cost summary", [{ type: "strong" }]),
        textNode(` (model: ${breakdown.model})`),
      ]),
      table,
      paragraph([textNode(`Updated ${breakdown.updatedAt}`, [{ type: "em" }])]),
    ],
  };
}

function headerRow(): AdfNode {
  return {
    type: "tableRow",
    content: HEADERS.map((label) => headerCell(label)),
  };
}

function phaseRow(row: PhaseCostRow): AdfNode {
  const values = [
    row.phase,
    String(row.iterations),
    formatTokens(row.usage.inputTokens),
    formatTokens(row.usage.outputTokens),
    formatTokens(row.usage.cacheReadTokens),
    formatTokens(row.usage.cacheCreationTokens),
    formatUsd(row.costUsd),
  ];
  return {
    type: "tableRow",
    content: values.map((text) => cell(text)),
  };
}

function totalRow(totalUsd: number): AdfNode {
  // Label + value occupy the first and last columns; every column in between
  // is blank so a HEADERS change can't silently drop or add a cell.
  const blanks = HEADERS.slice(1, -1).map(() => cell(""));
  return {
    type: "tableRow",
    content: [cell("Total", true), ...blanks, cell(formatUsd(totalUsd), true)],
  };
}

function emptyRow(): AdfNode {
  return {
    type: "tableRow",
    content: [
      {
        type: "tableCell",
        attrs: { colspan: HEADERS.length },
        content: [paragraph([textNode("(no phases recorded)", [{ type: "em" }])])],
      },
    ],
  };
}

function headerCell(label: string): AdfNode {
  return {
    type: "tableHeader",
    content: [paragraph([textNode(label)])],
  };
}

function cell(text: string, strong = false): AdfNode {
  if (text.length === 0) {
    return { type: "tableCell", content: [paragraph([])] };
  }
  const marks = strong === true ? [{ type: "strong" }] : undefined;
  return {
    type: "tableCell",
    content: [paragraph([textNode(text, marks)])],
  };
}

function paragraph(content: AdfNode[]): AdfNode {
  return { type: "paragraph", content };
}

function textNode(text: string, marks?: { type: string }[]): AdfNode {
  if (marks === undefined) {
    return { type: "text", text };
  }
  return { type: "text", text, marks };
}
