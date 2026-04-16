import type BetterSqlite3 from "better-sqlite3";
import type { PipelineRecord, OrchestratorState, OrchestratorStatus } from "./types.js";

// --- Pipeline state row shape ---

interface PipelineRow {
  issue_id: string;
  current_phase: string | null;
  branch_name: string | null;
  pr_number: number | null;
  worktree_path: string | null;
  review_iterations: number;
  feedback_iterations: number;
  spec_content: string | null;
  prior_context: string | null;
  created_at: string;
  updated_at: string;
}

// --- Pipeline state store ---

export class PipelineStateStore {
  private readonly db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  create(issueId: string, initialPhase?: string): PipelineRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pipeline_state (issue_id, current_phase, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(issueId, initialPhase ?? null, now, now);
    const record = this.get(issueId);
    if (record === null) {
      throw new Error(`Failed to create pipeline record for issue ${issueId}`);
    }
    return record;
  }

  get(issueId: string): PipelineRecord | null {
    const row = this.db.prepare("SELECT * FROM pipeline_state WHERE issue_id = ?").get(issueId) as
      | PipelineRow
      | undefined;
    if (row === undefined) {
      return null;
    }
    return toPipelineRecord(row);
  }

  updatePhase(issueId: string, phase: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE pipeline_state SET current_phase = ?, updated_at = ? WHERE issue_id = ?")
      .run(phase, now, issueId);
    return result.changes > 0;
  }

  updateBranch(issueId: string, branchName: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE pipeline_state SET branch_name = ?, updated_at = ? WHERE issue_id = ?")
      .run(branchName, now, issueId);
    return result.changes > 0;
  }

  updatePrNumber(issueId: string, prNumber: number): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE pipeline_state SET pr_number = ?, updated_at = ? WHERE issue_id = ?")
      .run(prNumber, now, issueId);
    return result.changes > 0;
  }

  updateWorktreePath(issueId: string, worktreePath: string | null): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE pipeline_state SET worktree_path = ?, updated_at = ? WHERE issue_id = ?")
      .run(worktreePath, now, issueId);
    return result.changes > 0;
  }

  incrementReviewIterations(issueId: string): number {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE pipeline_state SET review_iterations = review_iterations + 1, updated_at = ? WHERE issue_id = ?",
      )
      .run(now, issueId);
    const row = this.db
      .prepare("SELECT review_iterations FROM pipeline_state WHERE issue_id = ?")
      .get(issueId) as { review_iterations: number } | undefined;
    return row?.review_iterations ?? 0;
  }

  incrementFeedbackIterations(issueId: string): number {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE pipeline_state SET feedback_iterations = feedback_iterations + 1, updated_at = ? WHERE issue_id = ?",
      )
      .run(now, issueId);
    const row = this.db
      .prepare("SELECT feedback_iterations FROM pipeline_state WHERE issue_id = ?")
      .get(issueId) as { feedback_iterations: number } | undefined;
    return row?.feedback_iterations ?? 0;
  }

  updateSpec(issueId: string, specContent: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE pipeline_state SET spec_content = ?, updated_at = ? WHERE issue_id = ?")
      .run(specContent, now, issueId);
    return result.changes > 0;
  }

  updatePriorContext(issueId: string, priorContext: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE pipeline_state SET prior_context = ?, updated_at = ? WHERE issue_id = ?")
      .run(priorContext, now, issueId);
    return result.changes > 0;
  }

  delete(issueId: string): boolean {
    const result = this.db.prepare("DELETE FROM pipeline_state WHERE issue_id = ?").run(issueId);
    return result.changes > 0;
  }

  listAll(): PipelineRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM pipeline_state ORDER BY updated_at DESC")
      .all() as PipelineRow[];
    return rows.map(toPipelineRecord);
  }
}

// --- Orchestrator state store ---

export class OrchestratorStateStore {
  private readonly db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
    this.ensureDefaults();
  }

  private ensureDefaults(): void {
    const defaults: Record<string, string> = {
      status: "stopped",
      current_task_id: "",
      last_poll: "",
      completed_count: "0",
      error_count: "0",
      started_at: "",
    };

    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO orchestrator_state (key, value) VALUES (?, ?)",
    );
    for (const [key, value] of Object.entries(defaults)) {
      insert.run(key, value);
    }
  }

  get(): OrchestratorState {
    const rows = this.db.prepare("SELECT key, value FROM orchestrator_state").all() as {
      key: string;
      value: string;
    }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));

    return {
      status: (map.get("status") ?? "stopped") as OrchestratorStatus,
      currentTaskId: emptyToNull(map.get("current_task_id")),
      lastPoll: emptyToNull(map.get("last_poll")),
      completedCount: parseInt(map.get("completed_count") ?? "0", 10),
      errorCount: parseInt(map.get("error_count") ?? "0", 10),
      startedAt: emptyToNull(map.get("started_at")),
    };
  }

  setStatus(status: OrchestratorStatus): void {
    this.setValue("status", status);
  }

  setCurrentTaskId(taskId: string | null): void {
    this.setValue("current_task_id", taskId ?? "");
  }

  setLastPoll(timestamp: string): void {
    this.setValue("last_poll", timestamp);
  }

  incrementCompleted(): void {
    this.db
      .prepare(
        "UPDATE orchestrator_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'completed_count'",
      )
      .run();
  }

  incrementErrors(): void {
    this.db
      .prepare(
        "UPDATE orchestrator_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'error_count'",
      )
      .run();
  }

  setStartedAt(timestamp: string): void {
    this.setValue("started_at", timestamp);
  }

  reset(): void {
    this.db.prepare("DELETE FROM orchestrator_state").run();
    this.ensureDefaults();
  }

  private setValue(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO orchestrator_state (key, value) VALUES (?, ?)")
      .run(key, value);
  }
}

// --- Helpers ---

function emptyToNull(value: string | undefined): string | null {
  if (value === undefined || value === "") {
    return null;
  }
  return value;
}

function toPipelineRecord(row: PipelineRow): PipelineRecord {
  return {
    issueId: row.issue_id,
    currentPhase: row.current_phase,
    branchName: row.branch_name,
    prNumber: row.pr_number,
    worktreePath: row.worktree_path,
    reviewIterations: row.review_iterations,
    feedbackIterations: row.feedback_iterations,
    specContent: row.spec_content,
    priorContext: row.prior_context,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
