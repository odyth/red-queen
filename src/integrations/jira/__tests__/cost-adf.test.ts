import { describe, expect, it } from "vitest";
import { renderBreakdownAdf } from "../cost-adf.js";
import { JIRA_COST_MARKER } from "../cost-comment.js";
import { COST_DISCLAIMER } from "../../../core/cost-format.js";
import type { CostBreakdown } from "../../../core/types.js";
import type { AdfNode } from "../adf.js";

const row = (phase: string, iterations: number, cost: number): CostBreakdown["phases"][number] => ({
  phase,
  iterations,
  usage: {
    inputTokens: 1500,
    outputTokens: 200,
    cacheReadTokens: 3400,
    cacheCreationTokens: 0,
  },
  costUsd: cost,
});

function findFirst(node: AdfNode, type: string): AdfNode | null {
  if (node.type === type) {
    return node;
  }
  for (const child of node.content ?? []) {
    const hit = findFirst(child, type);
    if (hit !== null) {
      return hit;
    }
  }
  return null;
}

function findAll(node: AdfNode, type: string): AdfNode[] {
  const hits: AdfNode[] = [];
  if (node.type === type) {
    hits.push(node);
  }
  for (const child of node.content ?? []) {
    hits.push(...findAll(child, type));
  }
  return hits;
}

function cellText(cell: AdfNode): string {
  const texts: string[] = [];
  const walk = (n: AdfNode): void => {
    if (typeof n.text === "string") {
      texts.push(n.text);
    }
    for (const child of n.content ?? []) {
      walk(child);
    }
  };
  walk(cell);
  return texts.join("");
}

function expectNode(node: AdfNode | null | undefined, type: string): AdfNode {
  if (node === null || node === undefined) {
    throw new Error(`expected a node of type "${type}", got ${String(node)}`);
  }
  return node;
}

describe("renderBreakdownAdf", () => {
  it("produces a real ADF table (not markdown in a paragraph)", () => {
    const breakdown: CostBreakdown = {
      totalCostUsd: 1.23,
      model: "opus",
      currency: "USD",
      phases: [row("spec-writing", 1, 0.5), row("coding", 2, 0.73)],
      updatedAt: "2026-05-11T12:00:00Z",
    };
    const doc = renderBreakdownAdf(breakdown);
    expect(doc.type).toBe("doc");

    const table = expectNode(findFirst(doc, "table"), "table");

    // header + 2 phase rows + total row
    const rows = findAll(table, "tableRow");
    expect(rows).toHaveLength(4);

    const headers = findAll(table, "tableHeader");
    expect(headers.map(cellText)).toEqual([
      "Phase",
      "Iterations",
      "Input",
      "Output",
      "Cache read",
      "Cache write",
      "Cost",
    ]);

    const firstBodyRow = expectNode(rows[1], "tableRow");
    const firstCells = (firstBodyRow.content ?? []).map(cellText);
    expect(firstCells[0]).toBe("spec-writing");
    expect(firstCells[firstCells.length - 1]).toBe("$0.50");

    const totalRow = expectNode(rows[rows.length - 1], "tableRow");
    const totalCells = (totalRow.content ?? []).map(cellText);
    expect(totalCells[0]).toBe("Total");
    expect(totalCells[totalCells.length - 1]).toBe("$1.23");
  });

  it("leads with the upsert marker and includes the estimate disclaimer", () => {
    const breakdown: CostBreakdown = {
      totalCostUsd: 1.23,
      model: "opus",
      currency: "USD",
      phases: [row("coding", 1, 1.23)],
      updatedAt: "2026-05-29T00:00:00Z",
    };
    const doc = renderBreakdownAdf(breakdown);
    const firstParagraph = expectNode(findFirst(doc, "paragraph"), "paragraph");
    expect(cellText(firstParagraph).startsWith(JIRA_COST_MARKER)).toBe(true);
    expect(cellText(doc)).toContain(COST_DISCLAIMER);
  });

  it("renders an empty state when no phases are recorded", () => {
    const breakdown: CostBreakdown = {
      totalCostUsd: 0,
      model: "haiku",
      currency: "USD",
      phases: [],
      updatedAt: "now",
    };
    const doc = renderBreakdownAdf(breakdown);
    const table = expectNode(findFirst(doc, "table"), "table");
    const rows = findAll(table, "tableRow");
    // header + empty-state row + total row
    expect(rows).toHaveLength(3);
    const emptyRow = expectNode(rows[1], "tableRow");
    const emptyCell = expectNode(findAll(emptyRow, "tableCell")[0], "tableCell");
    expect(emptyCell.attrs?.colspan).toBe(7);
    expect(cellText(emptyCell)).toContain("(no phases recorded)");
  });

  it("marks Total label and value as strong", () => {
    const breakdown: CostBreakdown = {
      totalCostUsd: 2,
      model: "opus",
      currency: "USD",
      phases: [row("coding", 1, 2)],
      updatedAt: "now",
    };
    const doc = renderBreakdownAdf(breakdown);
    const table = expectNode(findFirst(doc, "table"), "table");
    const rows = findAll(table, "tableRow");
    const totalRow = expectNode(rows[rows.length - 1], "tableRow");
    const cells = totalRow.content ?? [];
    const firstCell = expectNode(cells[0], "tableCell");
    const lastCell = expectNode(cells[cells.length - 1], "tableCell");
    const firstText = expectNode(findFirst(firstCell, "text"), "text");
    const lastText = expectNode(findFirst(lastCell, "text"), "text");
    expect(firstText.marks?.some((m) => m.type === "strong")).toBe(true);
    expect(lastText.marks?.some((m) => m.type === "strong")).toBe(true);
  });
});
