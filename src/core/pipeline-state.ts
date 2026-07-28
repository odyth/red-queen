import type BetterSqlite3 from "better-sqlite3";
import type { OrchestratorState, OrchestratorStatus, PipelineRecord } from "./types.js";

// --- Pipeline state row shape ---

interface PipelineRow {
  issue_id: string;
  current_phase: string | null;
  prior_phase: string | null;
  branch_name: string | null;
  pr_number: number | null;
  pr_base_branch: string | null;
  terminal_pr_number: number | null;
  worktree_path: string | null;
  review_iterations: number;
  feedback_iterations: number;
  spec_content: string | null;
  prior_context: string | null;
  delegator_account_id: string | null;
  open_question_count: number | null;
  created_at: string;
  updated_at: string;
}

export type MergeTransitionResult = "processed" | "already-processed" | "stale" | "missing";

// Single source of truth for the merged-PR transition rules. The webhook's
// classifyMergedPrEvent (early exit, before side effects) and markPrMerged
// (transactional recheck at claim time) are intentionally layered — both must
// route through this predicate so the layers cannot drift.
export function classifyMergeTransition(
  row: { currentPhase: string | null; prNumber: number | null; terminalPrNumber: number | null },
  mergedPrNumber: number | null,
): "process" | "already-processed" | "stale" {
  if (row.currentPhase === "done" && row.prNumber === null) {
    if (mergedPrNumber === null || row.terminalPrNumber === mergedPrNumber) {
      return "already-processed";
    }
    return "stale";
  }
  if (
    mergedPrNumber !== null &&
    ((row.prNumber !== null && row.prNumber !== mergedPrNumber) ||
      (row.currentPhase !== "done" && row.terminalPrNumber === mergedPrNumber))
  ) {
    return "stale";
  }
  return "process";
}

// --- Pipeline state store ---

export class PipelineStateStore {
  private readonly db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  create(
    issueId: string,
    initialPhase?: string,
    delegatorAccountId?: string | null,
  ): PipelineRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pipeline_state (issue_id, current_phase, delegator_account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(issueId, initialPhase ?? null, delegatorAccountId ?? null, now, now);
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
    // Shift the outgoing phase into prior_phase atomically. SQLite evaluates the
    // RHS against the pre-update row, so prior_phase captures current_phase as it
    // was before this transition. Every transition path funnels through here, so
    // a dispatched skill can read prior_phase to know what ran before it.
    const result = this.db
      .prepare(
        "UPDATE pipeline_state SET prior_phase = current_phase, current_phase = ?, updated_at = ? WHERE issue_id = ?",
      )
      .run(phase, now, issueId);
    return result.changes > 0;
  }

  markDone(issueId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE pipeline_state
         SET prior_phase = CASE
               WHEN current_phase = 'done' THEN prior_phase
               ELSE current_phase
             END,
             current_phase = 'done',
             terminal_pr_number = CASE
               WHEN current_phase = 'done' THEN terminal_pr_number
               ELSE pr_number
             END,
             updated_at = ?
         WHERE issue_id = ?`,
      )
      .run(now, issueId);
    return result.changes > 0;
  }

  markPrMerged(issueId: string, mergedPrNumber: number | null): MergeTransitionResult {
    return this.db.transaction((): MergeTransitionResult => {
      const row = this.db
        .prepare(
          `SELECT current_phase, pr_number, terminal_pr_number
           FROM pipeline_state
           WHERE issue_id = ?`,
        )
        .get(issueId) as
        | {
            current_phase: string | null;
            pr_number: number | null;
            terminal_pr_number: number | null;
          }
        | undefined;
      if (row === undefined) {
        return "missing";
      }

      const disposition = classifyMergeTransition(
        {
          currentPhase: row.current_phase,
          prNumber: row.pr_number,
          terminalPrNumber: row.terminal_pr_number,
        },
        mergedPrNumber,
      );
      if (disposition !== "process") {
        return disposition;
      }

      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE pipeline_state
           SET prior_phase = CASE
                 WHEN current_phase = 'done' THEN prior_phase
                 ELSE current_phase
               END,
               current_phase = 'done',
               terminal_pr_number = COALESCE(?, pr_number),
               pr_number = NULL,
               pr_base_branch = NULL,
               updated_at = ?
           WHERE issue_id = ?`,
        )
        .run(mergedPrNumber, now, issueId);
      return "processed";
    })();
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

  updateBranchInfo(
    issueId: string,
    info: {
      branchName?: string | null;
      prNumber?: number | null;
      prBaseBranch?: string | null;
      worktreePath?: string | null;
    },
  ): PipelineRecord {
    const existing = this.get(issueId);
    if (existing === null) {
      throw new Error(`Cannot update branch info: no pipeline record for issue ${issueId}`);
    }

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (Object.prototype.hasOwnProperty.call(info, "branchName")) {
      sets.push("branch_name = ?");
      params.push(info.branchName ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(info, "prNumber")) {
      sets.push("pr_number = ?");
      params.push(info.prNumber ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(info, "prBaseBranch")) {
      sets.push("pr_base_branch = ?");
      params.push(info.prBaseBranch ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(info, "worktreePath")) {
      sets.push("worktree_path = ?");
      params.push(info.worktreePath ?? null);
    }
    if (sets.length === 0) {
      return existing;
    }

    const now = new Date().toISOString();
    sets.push("updated_at = ?");
    params.push(now);
    params.push(issueId);

    this.db
      .prepare(`UPDATE pipeline_state SET ${sets.join(", ")} WHERE issue_id = ?`)
      .run(...params);

    const updated = this.get(issueId);
    if (updated === null) {
      throw new Error(`Pipeline record for ${issueId} disappeared during updateBranchInfo`);
    }
    return updated;
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

  resetIterations(issueId: string): boolean {
    const now = new Date().toISOString();
    // open_question_count is also cleared: it's a per-cycle signal set by
    // each spec-writing run, and a stale value left over from a previous
    // gate visit would mislead the skip-gate router.
    const result = this.db
      .prepare(
        `UPDATE pipeline_state SET
           review_iterations = 0,
           feedback_iterations = 0,
           open_question_count = NULL,
           updated_at = ?
         WHERE issue_id = ?`,
      )
      .run(now, issueId);
    return result.changes > 0;
  }

  resetReviewIterations(issueId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE pipeline_state SET review_iterations = 0, updated_at = ? WHERE issue_id = ?")
      .run(now, issueId);
    return result.changes > 0;
  }

  updateSpec(issueId: string, specContent: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE pipeline_state SET spec_content = ?, updated_at = ? WHERE issue_id = ?")
      .run(specContent, now, issueId);
    return result.changes > 0;
  }

  clearSpec(issueId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE pipeline_state SET spec_content = NULL, updated_at = ? WHERE issue_id = ?")
      .run(now, issueId);
    return result.changes > 0;
  }

  updatePriorContext(issueId: string, priorContext: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE pipeline_state SET prior_context = ?, updated_at = ? WHERE issue_id = ?")
      .run(priorContext, now, issueId);
    return result.changes > 0;
  }

  updateDelegator(issueId: string, accountId: string | null): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE pipeline_state SET delegator_account_id = ?, updated_at = ? WHERE issue_id = ?",
      )
      .run(accountId, now, issueId);
    return result.changes > 0;
  }

  setOpenQuestionCount(issueId: string, count: number | null): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE pipeline_state SET open_question_count = ?, updated_at = ? WHERE issue_id = ?",
      )
      .run(count, now, issueId);
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
    const defaults: [string, string | null][] = [
      ["status", "stopped"],
      ["current_task_id", null],
      ["last_poll", null],
      ["completed_count", "0"],
      ["error_count", "0"],
      ["started_at", null],
    ];

    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO orchestrator_state (key, value) VALUES (?, ?)",
    );
    for (const [key, value] of defaults) {
      insert.run(key, value);
    }
  }

  get(): OrchestratorState {
    const rows = this.db.prepare("SELECT key, value FROM orchestrator_state").all() as {
      key: string;
      value: string | null;
    }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));

    return {
      status: (map.get("status") ?? "stopped") as OrchestratorStatus,
      currentTaskId: map.get("current_task_id") ?? null,
      lastPoll: map.get("last_poll") ?? null,
      completedCount: parseInt(map.get("completed_count") ?? "0", 10),
      errorCount: parseInt(map.get("error_count") ?? "0", 10),
      startedAt: map.get("started_at") ?? null,
    };
  }

  setStatus(status: OrchestratorStatus): void {
    this.setValue("status", status);
  }

  setCurrentTaskId(taskId: string | null): void {
    this.setValueNullable("current_task_id", taskId);
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
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM orchestrator_state").run();
      this.ensureDefaults();
    })();
  }

  private setValue(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO orchestrator_state (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  private setValueNullable(key: string, value: string | null): void {
    this.db
      .prepare("INSERT OR REPLACE INTO orchestrator_state (key, value) VALUES (?, ?)")
      .run(key, value);
  }
}

function toPipelineRecord(row: PipelineRow): PipelineRecord {
  return {
    issueId: row.issue_id,
    currentPhase: row.current_phase,
    priorPhase: row.prior_phase,
    branchName: row.branch_name,
    prNumber: row.pr_number,
    prBaseBranch: row.pr_base_branch,
    terminalPrNumber: row.terminal_pr_number,
    worktreePath: row.worktree_path,
    reviewIterations: row.review_iterations,
    feedbackIterations: row.feedback_iterations,
    specContent: row.spec_content,
    priorContext: row.prior_context,
    delegatorAccountId: row.delegator_account_id,
    openQuestionCount: row.open_question_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
