import type BetterSqlite3 from "better-sqlite3";

export type SubIterationStatus = "in-progress" | "completed" | "failed";

export interface SubIterationRecord {
  id: number;
  issueId: string;
  phaseName: string;
  subIterIndex: number;
  label: string;
  status: SubIterationStatus;
  summary: string | null;
  startedAt: string;
  completedAt: string | null;
}

interface SubIterationRow {
  id: number;
  issue_id: string;
  phase_name: string;
  sub_iter_index: number;
  label: string;
  status: string;
  summary: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface StartOptions {
  issueId: string;
  phaseName: string;
  label: string;
  now?: string;
}

export interface CompleteOptions {
  issueId: string;
  summary: string;
  now?: string;
}

export class SubIterationStore {
  private readonly db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  start(options: StartOptions): SubIterationRecord {
    const startedAt = options.now ?? new Date().toISOString();
    // sub_iter_index is monotonically increasing per (issue_id, phase_name) —
    // a phase that re-dispatches gets index 0, 1, 2... in dispatch order so
    // the dashboard can show "iter 1/N: <label>" without separate bookkeeping.
    const nextIndex = this.nextIndex(options.issueId, options.phaseName);
    const result = this.db
      .prepare(
        `INSERT INTO phase_sub_iterations
           (issue_id, phase_name, sub_iter_index, label, status, started_at)
         VALUES (?, ?, ?, ?, 'in-progress', ?)`,
      )
      .run(options.issueId, options.phaseName, nextIndex, options.label, startedAt);
    const id = Number(result.lastInsertRowid);
    const record = this.getById(id);
    if (record === null) {
      throw new Error(`sub-iter start: failed to read back inserted record ${String(id)}`);
    }
    return record;
  }

  completeLatestOpen(options: CompleteOptions): SubIterationRecord | null {
    const completedAt = options.now ?? new Date().toISOString();
    const open = this.latestOpen(options.issueId);
    if (open === null) {
      return null;
    }
    this.db
      .prepare(
        `UPDATE phase_sub_iterations
           SET status = 'completed', summary = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(options.summary, completedAt, open.id);
    return this.getById(open.id);
  }

  listByIssue(issueId: string): SubIterationRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM phase_sub_iterations WHERE issue_id = ? ORDER BY started_at ASC, id ASC",
      )
      .all(issueId) as SubIterationRow[];
    return rows.map(toRecord);
  }

  private nextIndex(issueId: string, phaseName: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sub_iter_index), -1) AS max_index
           FROM phase_sub_iterations
          WHERE issue_id = ? AND phase_name = ?`,
      )
      .get(issueId, phaseName) as { max_index: number } | undefined;
    return (row?.max_index ?? -1) + 1;
  }

  private latestOpen(issueId: string): SubIterationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM phase_sub_iterations
           WHERE issue_id = ? AND status = 'in-progress'
           ORDER BY started_at DESC, id DESC
           LIMIT 1`,
      )
      .get(issueId) as SubIterationRow | undefined;
    if (row === undefined) {
      return null;
    }
    return toRecord(row);
  }

  private getById(id: number): SubIterationRecord | null {
    const row = this.db.prepare("SELECT * FROM phase_sub_iterations WHERE id = ?").get(id) as
      | SubIterationRow
      | undefined;
    if (row === undefined) {
      return null;
    }
    return toRecord(row);
  }
}

function toRecord(row: SubIterationRow): SubIterationRecord {
  if (row.status !== "in-progress" && row.status !== "completed" && row.status !== "failed") {
    throw new Error(
      `phase_sub_iterations row ${String(row.id)} has invalid status "${row.status}"`,
    );
  }
  return {
    id: row.id,
    issueId: row.issue_id,
    phaseName: row.phase_name,
    subIterIndex: row.sub_iter_index,
    label: row.label,
    status: row.status,
    summary: row.summary,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
