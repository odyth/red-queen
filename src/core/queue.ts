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
  hasOpenTask(issueId: string, taskType: string): boolean;
  listByStatus(status: TaskStatus): Task[];
  getTask(taskId: string): Task | null;
  purgeOld(olderThanDays: number): number;
}

// --- SQLite row shape ---

interface TaskRow {
  id: string;
  type: string;
  priority: number;
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

    // Count current ready tasks for positional priority
    const readyCount = (
      this.db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'ready'").get() as {
        count: number;
      }
    ).count;
    const priority = task.priority !== undefined ? Math.min(task.priority, readyCount) : readyCount;

    // Shift priorities of existing ready tasks at or after this position
    this.db
      .prepare("UPDATE tasks SET priority = priority + 1 WHERE status = 'ready' AND priority >= ?")
      .run(priority);

    this.db
      .prepare(
        `INSERT INTO tasks (id, type, priority, issue_id, status, description, created_at, retry_count, metadata)
         VALUES (?, ?, ?, ?, 'ready', ?, ?, 0, ?)`,
      )
      .run(
        id,
        task.type,
        priority,
        task.issueId ?? null,
        task.description ?? null,
        now,
        metadataJson,
      );

    const created = this.getTask(id);
    if (created === null) {
      throw new Error(`Failed to enqueue task ${id}`);
    }
    return created;
  }

  dequeue(): Task | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status = 'ready' ORDER BY priority ASC, created_at ASC LIMIT 1",
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
      .prepare("SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, created_at ASC")
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
    priority: row.priority,
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
