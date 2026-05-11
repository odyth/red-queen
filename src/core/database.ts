import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
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

  CREATE INDEX IF NOT EXISTS idx_tasks_status_created_at
    ON tasks(status, created_at);
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
    delegator_account_id TEXT,
    plan_review_verdict TEXT,
    plan_review_rating INTEGER,
    plan_review_blockers INTEGER,
    plan_review_open_questions INTEGER,
    plan_review_recorded_at TEXT,
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

  CREATE TABLE IF NOT EXISTS phase_usage (
    issue_id TEXT NOT NULL,
    phase_name TEXT NOT NULL,
    iterations INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (issue_id, phase_name)
  );

  CREATE INDEX IF NOT EXISTS idx_phase_usage_updated_at ON phase_usage(updated_at DESC);
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
      if (msg.includes("duplicate column") === false) {
        throw err;
      }
    }
    try {
      this.db.exec("ALTER TABLE pipeline_state ADD COLUMN delegator_account_id TEXT");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("duplicate column") === false) {
        throw err;
      }
    }
    // Phase 5: drop tasks.priority (replaced by pipeline_state.created_at ordering).
    // DROP COLUMN fails with "no such column" on already-migrated DBs — swallow it.
    this.db.exec("DROP INDEX IF EXISTS idx_tasks_status_priority_created");
    try {
      this.db.exec("ALTER TABLE tasks DROP COLUMN priority");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no such column") === false) {
        throw err;
      }
    }
    // Phase 6: plan-review verdict columns on pipeline_state.
    const planReviewColumns: string[] = [
      "ALTER TABLE pipeline_state ADD COLUMN plan_review_verdict TEXT",
      "ALTER TABLE pipeline_state ADD COLUMN plan_review_rating INTEGER",
      "ALTER TABLE pipeline_state ADD COLUMN plan_review_blockers INTEGER",
      "ALTER TABLE pipeline_state ADD COLUMN plan_review_open_questions INTEGER",
      "ALTER TABLE pipeline_state ADD COLUMN plan_review_recorded_at TEXT",
    ];
    for (const stmt of planReviewColumns) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("duplicate column") === false) {
          throw err;
        }
      }
    }
  }
}
