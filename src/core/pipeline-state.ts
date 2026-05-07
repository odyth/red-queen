import type BetterSqlite3 from "better-sqlite3";
import type {
  OrchestratorState,
  OrchestratorStatus,
  PipelineRecord,
  PlanReviewVerdict,
  PlanReviewVerdictKind,
} from "./types.js";

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
  delegator_account_id: string | null;
  plan_review_verdict: string | null;
  plan_review_rating: number | null;
  plan_review_blockers: number | null;
  plan_review_open_questions: number | null;
  plan_review_recorded_at: string | null;
  created_at: string;
  updated_at: string;
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

  updateBranchInfo(
    issueId: string,
    info: {
      branchName?: string | null;
      prNumber?: number | null;
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
    const result = this.db
      .prepare(
        `UPDATE pipeline_state SET
           review_iterations = 0,
           feedback_iterations = 0,
           plan_review_verdict = NULL,
           plan_review_rating = NULL,
           plan_review_blockers = NULL,
           plan_review_open_questions = NULL,
           plan_review_recorded_at = NULL,
           updated_at = ?
         WHERE issue_id = ?`,
      )
      .run(now, issueId);
    return result.changes > 0;
  }

  setPlanReviewVerdict(issueId: string, verdict: PlanReviewVerdict): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE pipeline_state SET
           plan_review_verdict = ?,
           plan_review_rating = ?,
           plan_review_blockers = ?,
           plan_review_open_questions = ?,
           plan_review_recorded_at = ?,
           updated_at = ?
         WHERE issue_id = ?`,
      )
      .run(
        verdict.verdict,
        verdict.rating,
        verdict.blockers,
        verdict.openQuestions,
        verdict.recordedAt,
        now,
        issueId,
      );
    return result.changes > 0;
  }

  clearPlanReviewVerdict(issueId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE pipeline_state SET
           plan_review_verdict = NULL,
           plan_review_rating = NULL,
           plan_review_blockers = NULL,
           plan_review_open_questions = NULL,
           plan_review_recorded_at = NULL,
           updated_at = ?
         WHERE issue_id = ?`,
      )
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
    branchName: row.branch_name,
    prNumber: row.pr_number,
    worktreePath: row.worktree_path,
    reviewIterations: row.review_iterations,
    feedbackIterations: row.feedback_iterations,
    specContent: row.spec_content,
    priorContext: row.prior_context,
    delegatorAccountId: row.delegator_account_id,
    planReviewVerdict: toPlanReviewVerdict(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPlanReviewVerdict(row: PipelineRow): PlanReviewVerdict | null {
  // All five columns are written together by setPlanReviewVerdict and cleared
  // together by clearPlanReviewVerdict/resetIterations, so if the verdict kind
  // is present the other fields must be present too. Anything else is a
  // corrupted row — surface it rather than silently returning null.
  if (row.plan_review_verdict === null) {
    return null;
  }
  if (row.plan_review_verdict !== "approve" && row.plan_review_verdict !== "request-changes") {
    throw new Error(
      `plan_review_verdict has invalid value "${row.plan_review_verdict}" for issue ${row.issue_id}`,
    );
  }
  if (
    row.plan_review_rating === null ||
    row.plan_review_blockers === null ||
    row.plan_review_open_questions === null ||
    row.plan_review_recorded_at === null
  ) {
    throw new Error(
      `plan_review_* columns are partially populated for issue ${row.issue_id} — refusing to hydrate`,
    );
  }
  const kind: PlanReviewVerdictKind = row.plan_review_verdict;
  return {
    verdict: kind,
    rating: row.plan_review_rating,
    blockers: row.plan_review_blockers,
    openQuestions: row.plan_review_open_questions,
    recordedAt: row.plan_review_recorded_at,
  };
}
