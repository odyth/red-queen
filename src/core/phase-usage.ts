import type BetterSqlite3 from "better-sqlite3";
import type { CostBreakdown, PhaseCostRow, PhaseUsage, RunUsage } from "./types.js";
import type { PhaseGraph } from "./types.js";

interface PhaseUsageRow {
  issue_id: string;
  phase_name: string;
  iterations: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  updated_at: string;
}

interface TicketSummaryRow {
  issue_id: string;
  total_cost: number;
  total_iterations: number;
  updated_at: string;
  current_phase: string | null;
}

export interface CostTicketSummary {
  issueId: string;
  totalCostUsd: number;
  runCount: number;
  updatedAt: string;
  currentPhase: string | null;
}

export class PhaseUsageStore {
  private readonly db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  recordRun(issueId: string, phaseName: string, usage: RunUsage, costUsd: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO phase_usage (
           issue_id, phase_name, iterations,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
           cost_usd, updated_at
         )
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_id, phase_name) DO UPDATE SET
           iterations = iterations + 1,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
           cost_usd = cost_usd + excluded.cost_usd,
           updated_at = excluded.updated_at`,
      )
      .run(
        issueId,
        phaseName,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheCreationTokens,
        costUsd,
        now,
      );
  }

  getForIssue(issueId: string): PhaseUsage[] {
    const rows = this.db
      .prepare("SELECT * FROM phase_usage WHERE issue_id = ?")
      .all(issueId) as PhaseUsageRow[];
    return rows.map(toPhaseUsage);
  }

  buildBreakdown(issueId: string, phaseGraph: PhaseGraph, model: string): CostBreakdown {
    const rows = this.getForIssue(issueId);
    const byPhase = new Map(rows.map((r) => [r.phaseName, r]));
    // Graph order gives a predictable top-down reading — spec-writing first,
    // done last — instead of whichever insert order the DB happened to keep.
    const ordered: PhaseCostRow[] = [];
    for (const phase of phaseGraph.getAllPhases()) {
      const row = byPhase.get(phase.name);
      if (row === undefined) {
        continue;
      }
      ordered.push(toCostRow(row));
      byPhase.delete(phase.name);
    }
    // Any phases not represented in the graph (deleted phases, historical
    // data) get appended so they're still visible.
    for (const row of byPhase.values()) {
      ordered.push(toCostRow(row));
    }
    const total = ordered.reduce((sum, r) => sum + r.costUsd, 0);
    const updatedAt = rows.reduce<string>((latest, r) => {
      return r.updatedAt > latest ? r.updatedAt : latest;
    }, "");
    return {
      totalCostUsd: total,
      phases: ordered,
      currency: "USD",
      model,
      updatedAt: updatedAt === "" ? new Date().toISOString() : updatedAt,
    };
  }

  listTicketSummaries(limit = 50): CostTicketSummary[] {
    const rows = this.db
      .prepare(
        `SELECT
           u.issue_id AS issue_id,
           SUM(u.cost_usd) AS total_cost,
           SUM(u.iterations) AS total_iterations,
           MAX(u.updated_at) AS updated_at,
           ps.current_phase AS current_phase
         FROM phase_usage u
         LEFT JOIN pipeline_state ps ON ps.issue_id = u.issue_id
         GROUP BY u.issue_id
         ORDER BY MAX(u.updated_at) DESC
         LIMIT ?`,
      )
      .all(limit) as TicketSummaryRow[];
    return rows.map((r) => ({
      issueId: r.issue_id,
      totalCostUsd: r.total_cost,
      runCount: r.total_iterations,
      updatedAt: r.updated_at,
      currentPhase: r.current_phase,
    }));
  }

  totalCostAcrossTickets(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM phase_usage")
      .get() as { total: number };
    return row.total;
  }
}

function toPhaseUsage(row: PhaseUsageRow): PhaseUsage {
  return {
    issueId: row.issue_id,
    phaseName: row.phase_name,
    iterations: row.iterations,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    costUsd: row.cost_usd,
    updatedAt: row.updated_at,
  };
}

function toCostRow(usage: PhaseUsage): PhaseCostRow {
  return {
    phase: usage.phaseName,
    iterations: usage.iterations,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
    },
    costUsd: usage.costUsd,
  };
}
