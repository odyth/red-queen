import { randomBytes } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import type { Task, TaskStatus, NewTask } from "./types.js";

// --- Interface ---

export interface TaskQueue {
  enqueue(task: NewTask): Task;
  dequeue(): Task | null;
  markWorking(taskId: string): boolean;
  markComplete(taskId: string, result: string): boolean;
  markFailed(taskId: string, error: string): boolean;
  requeue(taskId: string): boolean;
  hasOpenTask(issueId: string, taskType: string): boolean;
  listByStatus(status: TaskStatus): Task[];
  getTask(taskId: string): Task | null;
  getOpenCount(): { ready: number; working: number };
  purgeOld(olderThanDays: number): number;
}

// --- SQLite row shape ---

interface TaskRow {
  id: string;
  type: string;
  issue_id: string | null;
  status: string;
  description: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  result: string | null;
  retry_count: number;
  metadata: string | null;
}

// Ordering: tasks sort by the host issue's pipeline_state.created_at when a
// pipeline row exists ("when RQ first processed this ticket" — monotonic), or
// by the task's own created_at otherwise (e.g., new-ticket tasks before the
// pipeline row exists). This makes human feedback on an older ticket naturally
// preempt newer tickets without needing a priority field.
//
// `t.rowid` is the final tiebreaker: SQLite assigns a monotonic integer rowid
// per insert, so tasks enqueued within the same ISO-ms have deterministic,
// insertion-order dequeue. `tasks.id` has a ms-lexical prefix but a random
// hex suffix, so it's not a reliable tiebreaker within the same ms.
const ORDER_CLAUSE = "COALESCE(ps.created_at, t.created_at) ASC, t.created_at ASC, t.rowid ASC";

// --- Implementation ---

export class SqliteTaskQueue implements TaskQueue {
  private readonly db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  enqueue(task: NewTask): Task {
    const id = generateTaskId();
    const now = new Date().toISOString();
    const metadataJson = task.metadata ? JSON.stringify(task.metadata) : null;

    this.db
      .prepare(
        `INSERT INTO tasks (id, type, issue_id, status, description, created_at, retry_count, metadata)
         VALUES (?, ?, ?, 'ready', ?, ?, 0, ?)`,
      )
      .run(id, task.type, task.issueId ?? null, task.description ?? null, now, metadataJson);

    const created = this.getTask(id);
    if (created === null) {
      throw new Error(`Failed to enqueue task ${id}`);
    }
    return created;
  }

  dequeue(): Task | null {
    const row = this.db
      .prepare(
        `SELECT t.* FROM tasks t
         LEFT JOIN pipeline_state ps ON ps.issue_id = t.issue_id
         WHERE t.status = 'ready'
         ORDER BY ${ORDER_CLAUSE}
         LIMIT 1`,
      )
      .get() as TaskRow | undefined;

    if (row === undefined) {
      return null;
    }

    return toTask(row);
  }

  markWorking(taskId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE tasks SET status = 'working', started_at = ? WHERE id = ? AND status = 'ready'",
      )
      .run(now, taskId);
    return result.changes > 0;
  }

  markComplete(taskId: string, result: string): boolean {
    const now = new Date().toISOString();
    const dbResult = this.db
      .prepare(
        "UPDATE tasks SET status = 'complete', completed_at = ?, result = ? WHERE id = ? AND status = 'working'",
      )
      .run(now, result, taskId);
    return dbResult.changes > 0;
  }

  markFailed(taskId: string, error: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE tasks SET status = 'failed', completed_at = ?, result = ?, retry_count = retry_count + 1 WHERE id = ? AND status = 'working'",
      )
      .run(now, error, taskId);
    return result.changes > 0;
  }

  requeue(taskId: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE tasks SET status = 'ready', started_at = NULL WHERE id = ? AND status = 'working'",
      )
      .run(taskId);
    return result.changes > 0;
  }

  hasOpenTask(issueId: string, taskType: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM tasks WHERE issue_id = ? AND type = ? AND status IN ('ready', 'working') LIMIT 1",
      )
      .get(issueId, taskType) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  listByStatus(status: TaskStatus): Task[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t
         LEFT JOIN pipeline_state ps ON ps.issue_id = t.issue_id
         WHERE t.status = ?
         ORDER BY ${ORDER_CLAUSE}`,
      )
      .all(status) as TaskRow[];
    return rows.map(toTask);
  }

  getTask(taskId: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    if (row === undefined) {
      return null;
    }
    return toTask(row);
  }

  getOpenCount(): { ready: number; working: number } {
    const row = this.db
      .prepare(
        "SELECT SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready, SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END) as working FROM tasks WHERE status IN ('ready', 'working')",
      )
      .get() as { ready: number | null; working: number | null };
    return { ready: row.ready ?? 0, working: row.working ?? 0 };
  }

  purgeOld(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db
      .prepare("DELETE FROM tasks WHERE status IN ('complete', 'failed') AND completed_at < ?")
      .run(cutoff);
    return result.changes;
  }
}

// --- Helpers ---

function generateTaskId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    type: row.type,
    issueId: row.issue_id,
    status: row.status as TaskStatus,
    description: row.description,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    result: row.result,
    retryCount: row.retry_count,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {},
  };
}
