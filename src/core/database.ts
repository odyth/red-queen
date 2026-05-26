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
    open_question_count INTEGER,
    parsed_open_question_count INTEGER,
    files_affected_count INTEGER,
    last_ai_spec_hash TEXT,
    last_ai_spec_at TEXT,
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

  CREATE TABLE IF NOT EXISTS phase_sub_iterations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id TEXT NOT NULL,
    phase_name TEXT NOT NULL,
    sub_iter_index INTEGER NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in-progress',
    summary TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT
  );

  -- UNIQUE index doubles as the (issue_id, phase_name, sub_iter_index)
  -- lookup index and enforces the constraint against concurrent inserts
  -- racing on max(sub_iter_index)+1.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_phase_sub_iterations_issue_phase_index
    ON phase_sub_iterations(issue_id, phase_name, sub_iter_index);
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
    // Phase 8 (v6): replace the non-unique idx_phase_sub_iterations_lookup
    // with a UNIQUE INDEX that enforces (issue_id, phase_name, sub_iter_index).
    // The new index is created by SCHEMA_SQL; here we just drop the old one
    // on already-migrated DBs so duplicate indexes don't accumulate.
    this.db.exec("DROP INDEX IF EXISTS idx_phase_sub_iterations_lookup");

    // Phase 7 (v6): drop plan-review verdict columns. The plan-review phase
    // was removed entirely; existing databases keep the column data until this
    // migration runs, at which point it's permanently gone.
    const droppedPlanReviewColumns: string[] = [
      "ALTER TABLE pipeline_state DROP COLUMN plan_review_verdict",
      "ALTER TABLE pipeline_state DROP COLUMN plan_review_rating",
      "ALTER TABLE pipeline_state DROP COLUMN plan_review_blockers",
      "ALTER TABLE pipeline_state DROP COLUMN plan_review_open_questions",
      "ALTER TABLE pipeline_state DROP COLUMN plan_review_recorded_at",
    ];
    for (const stmt of droppedPlanReviewColumns) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("no such column") === false) {
          throw err;
        }
      }
    }

    // Phase 2 (v6 multi-phase prompt-writer): spec-writer metadata columns.
    // open_question_count / files_affected_count are the writer's declared
    // counts; parsed_open_question_count is the server-side cross-check parsed
    // out of `spec set`; last_ai_spec_hash / last_ai_spec_at let the
    // orchestrator detect human inline edits between writer dispatches.
    // ALTER fails with a duplicate-column error on already-migrated DBs — swallow it.
    const addedSpecWriterColumns: string[] = [
      "ALTER TABLE pipeline_state ADD COLUMN open_question_count INTEGER",
      "ALTER TABLE pipeline_state ADD COLUMN parsed_open_question_count INTEGER",
      "ALTER TABLE pipeline_state ADD COLUMN files_affected_count INTEGER",
      "ALTER TABLE pipeline_state ADD COLUMN last_ai_spec_hash TEXT",
      "ALTER TABLE pipeline_state ADD COLUMN last_ai_spec_at TEXT",
    ];
    for (const stmt of addedSpecWriterColumns) {
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
