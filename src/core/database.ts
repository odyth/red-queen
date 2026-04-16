import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class RedQueenDatabase {
  readonly db: BetterSqlite3.Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
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

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
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
    `);
  }

  close(): void {
    this.db.close();
  }
}
