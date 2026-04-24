import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    issue_id TEXT,
    status TEXT NOT NULL DEFAULT 'ready',
    description TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    result TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    metadata TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status_priority_created
    ON tasks(status, priority, created_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_issue_id ON tasks(issue_id);

  CREATE TABLE IF NOT EXISTS pipeline_state (
    issue_id TEXT PRIMARY KEY,
    current_phase TEXT,
    branch_name TEXT,
    pr_number INTEGER,
    worktree_path TEXT,
    review_iterations INTEGER NOT NULL DEFAULT 0,
    feedback_iterations INTEGER NOT NULL DEFAULT 0,
    spec_content TEXT,
    prior_context TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orchestrator_state (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    component TEXT NOT NULL,
    issue_id TEXT,
    message TEXT NOT NULL,
    metadata TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_issue_id ON audit_log(issue_id);
`;

export class RedQueenDatabase {
  readonly db: BetterSqlite3.Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    this.runMigrations();
  }

  close(): void {
    this.db.close();
  }

  private runMigrations(): void {
    // Phase 4: worktree_path added to pipeline_state.
    // ALTER fails with a duplicate-column error on already-migrated DBs — swallow it.
    try {
      this.db.exec("ALTER TABLE pipeline_state ADD COLUMN worktree_path TEXT");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
      if (msg.includes("duplicate column") === false) {
        throw err;
      }
    }
  }
}
