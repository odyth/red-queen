import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { SCHEMA_SQL } from "../database.js";
import { PhaseUsageStore } from "../phase-usage.js";
import { buildPhaseGraph } from "../config.js";
import { DEFAULT_PHASES } from "../defaults.js";
import type { RunUsage } from "../types.js";

const usage = (inputTokens: number, outputTokens = 0): RunUsage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

describe("PhaseUsageStore", () => {
  let db: BetterSqlite3.Database;
  let store: PhaseUsageStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    store = new PhaseUsageStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("recordRun accumulates iterations and tokens across calls", () => {
    store.recordRun("ISSUE-1", "coding", usage(100, 50), 0.25);
    store.recordRun("ISSUE-1", "coding", usage(200, 30), 0.4);

    const rows = store.getForIssue("ISSUE-1");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error("expected a row");
    }
    expect(row.iterations).toBe(2);
    expect(row.inputTokens).toBe(300);
    expect(row.outputTokens).toBe(80);
    expect(row.costUsd).toBeCloseTo(0.65, 6);
  });

  it("separate phases are distinct rows", () => {
    store.recordRun("ISSUE-1", "spec-writing", usage(10), 0.01);
    store.recordRun("ISSUE-1", "coding", usage(20), 0.02);
    expect(store.getForIssue("ISSUE-1")).toHaveLength(2);
  });

  it("buildBreakdown orders phases by graph position and sums totals", () => {
    const graph = buildPhaseGraph(DEFAULT_PHASES);
    // Record out of graph order — store should re-order per the graph
    store.recordRun("ISSUE-1", "code-review", usage(0), 0.3);
    store.recordRun("ISSUE-1", "spec-writing", usage(0), 0.1);
    store.recordRun("ISSUE-1", "coding", usage(0), 0.2);

    const breakdown = store.buildBreakdown("ISSUE-1", graph, "opus");
    expect(breakdown.phases.map((p) => p.phase)).toEqual(["spec-writing", "coding", "code-review"]);
    expect(breakdown.totalCostUsd).toBeCloseTo(0.6, 6);
    expect(breakdown.model).toBe("opus");
    expect(breakdown.currency).toBe("USD");
  });

  it("listTicketSummaries groups across phases, orders by recency", () => {
    store.recordRun("ISSUE-A", "coding", usage(100), 0.1);
    store.recordRun("ISSUE-B", "coding", usage(100), 0.2);
    store.recordRun("ISSUE-B", "code-review", usage(50), 0.05);
    // Updating ISSUE-A bumps it to the top of the recency order
    store.recordRun("ISSUE-A", "code-review", usage(10), 0.01);

    const list = store.listTicketSummaries();
    expect(list).toHaveLength(2);
    const first = list[0];
    const second = list[1];
    if (first === undefined || second === undefined) {
      throw new Error("expected two rows");
    }
    expect(first.issueId).toBe("ISSUE-A");
    expect(first.totalCostUsd).toBeCloseTo(0.11, 6);
    expect(first.runCount).toBe(2);
    expect(second.issueId).toBe("ISSUE-B");
    expect(second.runCount).toBe(2);
  });

  it("totalCostAcrossTickets sums every row", () => {
    store.recordRun("A", "coding", usage(0), 0.25);
    store.recordRun("B", "coding", usage(0), 0.5);
    expect(store.totalCostAcrossTickets()).toBeCloseTo(0.75, 6);
  });
});
