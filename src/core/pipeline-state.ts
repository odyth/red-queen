import type BetterSqlite3 from "better-sqlite3";
import type {
  OrchestratorState,
  OrchestratorStatus,
  PipelineRecord,
  PipelineRepoRecord,
} from "./types.js";

export const DEFAULT_REPO_NAME = "default";

// --- Row shapes ---

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

interface PipelineRepoRow {
  issue_id: string;
  repo: string;
  in_scope: number;
  branch_name: string | null;
  pr_number: number | null;
  pr_base_branch: string | null;
  terminal_pr_number: number | null;
  merge_completed: number;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface BranchInfoUpdate {
  branchName?: string | null;
  prNumber?: number | null;
  prBaseBranch?: string | null;
  worktreePath?: string | null;
}

export type MergeTransitionResult =
  | "processed"
  | "already-processed"
  | "stale"
  | "missing"
  | "pending-others";

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

// Completion belongs to this issue cycle; terminal identity survives reopening
// to reject old deliveries. Partial merges are duplicates even before done.
export function classifyRepoMergeTransition(
  currentPhase: string | null,
  row: Pick<PipelineRepoRecord, "prNumber" | "terminalPrNumber" | "mergeCompleted">,
  mergedPrNumber: number | null,
): "process" | "already-processed" | "stale" {
  if (row.prNumber === null && row.mergeCompleted) {
    return mergedPrNumber === null || row.terminalPrNumber === mergedPrNumber
      ? "already-processed"
      : "stale";
  }
  return classifyMergeTransition(
    { currentPhase, prNumber: row.prNumber, terminalPrNumber: row.terminalPrNumber },
    mergedPrNumber,
  );
}

export function firstInScopeRepo(repos: readonly PipelineRepoRecord[]): PipelineRepoRecord | null {
  return repos.find((r) => r.inScope) ?? null;
}

// The repo a single-row caller acts on: the first in-scope row, else the
// fallback (the config's first repo — the only repo in legacy mode).
export function primaryRepoName(record: Pick<PipelineRecord, "repos">, fallback: string): string {
  return firstInScopeRepo(record.repos)?.repo ?? fallback;
}

// --- Pipeline state store ---

export class PipelineStateStore {
  private readonly db: BetterSqlite3.Database;
  private readonly repoNames: string[];

  constructor(db: BetterSqlite3.Database, repoNames: readonly string[] = [DEFAULT_REPO_NAME]) {
    this.db = db;
    this.repoNames = [...repoNames];
  }

  get defaultRepo(): string {
    return this.repoNames[0] ?? DEFAULT_REPO_NAME;
  }

  create(
    issueId: string,
    initialPhase?: string,
    delegatorAccountId?: string | null,
  ): PipelineRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pipeline_state (issue_id, current_phase, delegator_account_id, repo_state_version, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
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
    return toPipelineRecord(row, this.listRepos(issueId));
  }

  listAll(): PipelineRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM pipeline_state ORDER BY updated_at DESC")
      .all() as PipelineRow[];
    const repoRows = this.db.prepare("SELECT * FROM pipeline_repos").all() as PipelineRepoRow[];
    const byIssue = new Map<string, PipelineRepoRecord[]>();
    for (const repoRow of repoRows) {
      const list = byIssue.get(repoRow.issue_id) ?? [];
      list.push(toRepoRecord(repoRow));
      byIssue.set(repoRow.issue_id, list);
    }
    return rows.map((row) =>
      toPipelineRecord(row, this.sortRepos(byIssue.get(row.issue_id) ?? [])),
    );
  }

  listRepos(issueId: string): PipelineRepoRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM pipeline_repos WHERE issue_id = ?")
      .all(issueId) as PipelineRepoRow[];
    return this.sortRepos(rows.map(toRepoRecord));
  }

  getRepo(issueId: string, repo: string): PipelineRepoRecord | null {
    const row = this.db
      .prepare("SELECT * FROM pipeline_repos WHERE issue_id = ? AND repo = ?")
      .get(issueId, repo) as PipelineRepoRow | undefined;
    return row === undefined ? null : toRepoRecord(row);
  }

  findByPr(repo: string, prNumber: number): PipelineRecord | null {
    const row = this.db
      .prepare("SELECT issue_id FROM pipeline_repos WHERE repo = ? AND pr_number = ?")
      .get(repo, prNumber) as { issue_id: string } | undefined;
    return row === undefined ? null : this.get(row.issue_id);
  }

  // Upserts in-scope rows for the named repos and descopes every other row.
  // Rows are never deleted here: a descoped row keeps its branch, PR, and
  // worktree so a human can close the orphaned PR.
  setScope(issueId: string, repoNames: readonly string[]): PipelineRepoRecord[] {
    return this.db.transaction((): PipelineRepoRecord[] => {
      this.assertRecord(issueId);
      const now = new Date().toISOString();
      const upsert = this.db.prepare(
        `INSERT INTO pipeline_repos (issue_id, repo, in_scope, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(issue_id, repo) DO UPDATE SET in_scope = 1, updated_at = excluded.updated_at`,
      );
      for (const name of repoNames) {
        upsert.run(issueId, name, now, now);
      }
      if (repoNames.length === 0) {
        this.db
          .prepare("UPDATE pipeline_repos SET in_scope = 0, updated_at = ? WHERE issue_id = ?")
          .run(now, issueId);
      } else {
        const placeholders = repoNames.map(() => "?").join(", ");
        this.db
          .prepare(
            `UPDATE pipeline_repos SET in_scope = 0, updated_at = ?
             WHERE issue_id = ? AND repo NOT IN (${placeholders})`,
          )
          .run(now, issueId, ...repoNames);
      }
      this.refreshMirror(issueId, now);
      return this.listRepos(issueId);
    })();
  }

  updateBranchInfo(issueId: string, repo: string, info: BranchInfoUpdate): PipelineRepoRecord {
    return this.db.transaction((): PipelineRepoRecord => {
      this.assertRecord(issueId);
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO pipeline_repos (issue_id, repo, in_scope, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(issue_id, repo) DO NOTHING`,
        )
        .run(issueId, repo, now, now);

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
      // A replacement PR/branch starts fresh work; clearing cleanup artifacts
      // must retain completion while this issue waits for its sibling repos.
      const previous = this.getRepo(issueId, repo);
      if (
        (info.prNumber != null && info.prNumber !== previous?.prNumber) ||
        (info.branchName != null && info.branchName !== previous?.branchName)
      ) {
        sets.push("merge_completed = 0");
      }
      if (sets.length > 0) {
        sets.push("updated_at = ?");
        params.push(now, issueId, repo);
        this.db
          .prepare(`UPDATE pipeline_repos SET ${sets.join(", ")} WHERE issue_id = ? AND repo = ?`)
          .run(...params);
      }
      this.refreshMirror(issueId, now);
      const updated = this.getRepo(issueId, repo);
      if (updated === null) {
        throw new Error(`Repo row ${issueId}/${repo} disappeared during updateBranchInfo`);
      }
      return updated;
    })();
  }

  updateBranch(issueId: string, repo: string, branchName: string): boolean {
    this.updateBranchInfo(issueId, repo, { branchName });
    return true;
  }

  updatePrNumber(
    issueId: string,
    repo: string,
    prNumber: number,
    prBaseBranch: string | null,
  ): boolean {
    this.updateBranchInfo(issueId, repo, { prNumber, prBaseBranch });
    return true;
  }

  updateWorktreePath(issueId: string, repo: string, worktreePath: string | null): boolean {
    this.updateBranchInfo(issueId, repo, { worktreePath });
    return true;
  }

  updatePhase(issueId: string, phase: string): boolean {
    return this.db.transaction((): boolean => {
      const now = new Date().toISOString();
      if (phase !== "done") {
        this.db
          .prepare(
            `UPDATE pipeline_repos SET merge_completed = 0, updated_at = ?
             WHERE issue_id = ? AND EXISTS (
               SELECT 1 FROM pipeline_state WHERE issue_id = ? AND current_phase = 'done'
             )`,
          )
          .run(now, issueId, issueId);
      }
      // SQLite evaluates the RHS against the pre-update row, preserving the
      // outgoing phase for the next dispatched skill.
      const result = this.db
        .prepare(
          "UPDATE pipeline_state SET prior_phase = current_phase, current_phase = ?, updated_at = ? WHERE issue_id = ?",
        )
        .run(phase, now, issueId);
      if (result.changes > 0) {
        this.refreshMirror(issueId, now);
      }
      return result.changes > 0;
    })();
  }

  markDone(issueId: string): boolean {
    return this.db.transaction((): boolean => {
      const state = this.db
        .prepare("SELECT current_phase FROM pipeline_state WHERE issue_id = ?")
        .get(issueId) as { current_phase: string | null } | undefined;
      if (state === undefined) {
        return false;
      }
      const now = new Date().toISOString();
      if (state.current_phase !== "done") {
        this.db
          .prepare(
            `UPDATE pipeline_repos SET terminal_pr_number = COALESCE(pr_number, terminal_pr_number), updated_at = ?
             WHERE issue_id = ? AND in_scope = 1`,
          )
          .run(now, issueId);
        this.db
          .prepare(
            `UPDATE pipeline_state SET prior_phase = current_phase, current_phase = 'done', updated_at = ?
             WHERE issue_id = ?`,
          )
          .run(now, issueId);
      }
      this.refreshMirror(issueId, now);
      return true;
    })();
  }

  // Per-row terminal transition. The issue moves to done only inside the
  // transaction that completes all in-scope rows; a descoped row's merge
  // transitions that row and nothing else.
  markPrMerged(
    issueId: string,
    repo: string,
    mergedPrNumber: number | null,
  ): MergeTransitionResult {
    return this.db.transaction((): MergeTransitionResult => {
      const state = this.db
        .prepare("SELECT current_phase FROM pipeline_state WHERE issue_id = ?")
        .get(issueId) as { current_phase: string | null } | undefined;
      const row = this.getRepo(issueId, repo);
      if (state === undefined || row === null) {
        return "missing";
      }
      const disposition = classifyRepoMergeTransition(state.current_phase, row, mergedPrNumber);
      if (disposition !== "process") {
        return disposition;
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE pipeline_repos
           SET terminal_pr_number = COALESCE(?, pr_number),
               merge_completed = 1,
               pr_number = NULL,
               pr_base_branch = NULL,
               updated_at = ?
           WHERE issue_id = ? AND repo = ?`,
        )
        .run(mergedPrNumber, now, issueId, repo);
      const remaining = this.db
        .prepare(
          "SELECT COUNT(*) AS c FROM pipeline_repos WHERE issue_id = ? AND in_scope = 1 AND merge_completed = 0",
        )
        .get(issueId) as { c: number };
      if (row.inScope === false || remaining.c > 0) {
        this.refreshMirror(issueId, now);
        return "pending-others";
      }
      this.db
        .prepare(
          `UPDATE pipeline_state
           SET prior_phase = CASE WHEN current_phase = 'done' THEN prior_phase ELSE current_phase END,
               current_phase = 'done',
               updated_at = ?
           WHERE issue_id = ?`,
        )
        .run(now, issueId);
      this.refreshMirror(issueId, now);
      return "processed";
    })();
  }

  // Pre-upgrade rows with scalar state get a row for the config's first repo.
  // Modern workspace specs stay unscoped until scope is explicitly selected.
  // Explicit legacy mode preserves the sole-repo scope of modern legacy specs.
  adoptLegacyRows(repoName: string, legacyMode = false): string[] {
    return this.db.transaction((): string[] => {
      const candidates = this.db
        .prepare(
          `SELECT issue_id FROM pipeline_state ps
           WHERE (branch_name IS NOT NULL OR pr_number IS NOT NULL OR worktree_path IS NOT NULL
                  OR spec_content IS NOT NULL OR terminal_pr_number IS NOT NULL)
             AND (repo_state_version = 0 OR ? = 1)
             AND NOT EXISTS (SELECT 1 FROM pipeline_repos pr WHERE pr.issue_id = ps.issue_id)
           ORDER BY issue_id`,
        )
        .all(legacyMode ? 1 : 0) as { issue_id: string }[];
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO pipeline_repos
             (issue_id, repo, in_scope, branch_name, pr_number, pr_base_branch, terminal_pr_number, merge_completed, worktree_path, created_at, updated_at)
           SELECT issue_id, ?, 1, branch_name, pr_number, pr_base_branch, terminal_pr_number,
                  CASE WHEN current_phase = 'done' AND pr_number IS NULL AND terminal_pr_number IS NOT NULL THEN 1 ELSE 0 END,
                  worktree_path, created_at, ?
           FROM pipeline_state ps
           WHERE (branch_name IS NOT NULL OR pr_number IS NOT NULL OR worktree_path IS NOT NULL
                  OR spec_content IS NOT NULL OR terminal_pr_number IS NOT NULL)
             AND (repo_state_version = 0 OR ? = 1)
             AND NOT EXISTS (SELECT 1 FROM pipeline_repos pr WHERE pr.issue_id = ps.issue_id)`,
        )
        .run(repoName, now, legacyMode ? 1 : 0);
      // Mark even empty pre-upgrade records as seen: a later workspace spec
      // write must not become eligible for adoption on the next helper/start.
      this.db
        .prepare("UPDATE pipeline_state SET repo_state_version = 1 WHERE repo_state_version = 0")
        .run();
      for (const candidate of candidates) {
        this.refreshMirror(candidate.issue_id, now);
      }
      return candidates.map((c) => c.issue_id);
    })();
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

  // Spec scope and its gate metadata must become visible together. Omitting
  // repoNames preserves the existing scope for legacy single-repo callers.
  setSpecMetadata(
    issueId: string,
    count: number,
    repoNames?: readonly string[],
  ): PipelineRepoRecord[] {
    return this.db.transaction((): PipelineRepoRecord[] => {
      this.assertRecord(issueId);
      this.setOpenQuestionCount(issueId, count);
      return repoNames === undefined ? this.listRepos(issueId) : this.setScope(issueId, repoNames);
    })();
  }

  delete(issueId: string): boolean {
    return this.db.transaction((): boolean => {
      this.db.prepare("DELETE FROM pipeline_repos WHERE issue_id = ?").run(issueId);
      const result = this.db.prepare("DELETE FROM pipeline_state WHERE issue_id = ?").run(issueId);
      return result.changes > 0;
    })();
  }

  private assertRecord(issueId: string): void {
    const exists = this.db.prepare("SELECT 1 FROM pipeline_state WHERE issue_id = ?").get(issueId);
    if (exists === undefined) {
      throw new Error(`Cannot update branch info: no pipeline record for issue ${issueId}`);
    }
  }

  // Refresh the display-only scalar mirror from the first in-scope row. Called
  // inside every transaction that touches pipeline_repos.
  private refreshMirror(issueId: string, now: string): void {
    const first = firstInScopeRepo(this.listRepos(issueId));
    this.db
      .prepare(
        `UPDATE pipeline_state
         SET branch_name = ?, pr_number = ?, pr_base_branch = ?, terminal_pr_number = ?,
             worktree_path = ?, updated_at = ?
         WHERE issue_id = ?`,
      )
      .run(
        first?.branchName ?? null,
        first?.prNumber ?? null,
        first?.prBaseBranch ?? null,
        first?.terminalPrNumber ?? null,
        first?.worktreePath ?? null,
        now,
        issueId,
      );
  }

  private sortRepos(rows: PipelineRepoRecord[]): PipelineRepoRecord[] {
    const order = new Map(this.repoNames.map((name, index) => [name, index]));
    return [...rows].sort((a, b) => {
      const ia = order.get(a.repo) ?? Number.MAX_SAFE_INTEGER;
      const ib = order.get(b.repo) ?? Number.MAX_SAFE_INTEGER;
      if (ia !== ib) {
        return ia - ib;
      }
      return a.repo.localeCompare(b.repo);
    });
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

function toRepoRecord(row: PipelineRepoRow): PipelineRepoRecord {
  return {
    issueId: row.issue_id,
    repo: row.repo,
    inScope: row.in_scope === 1,
    branchName: row.branch_name,
    prNumber: row.pr_number,
    prBaseBranch: row.pr_base_branch,
    terminalPrNumber: row.terminal_pr_number,
    mergeCompleted: row.merge_completed === 1,
    worktreePath: row.worktree_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPipelineRecord(row: PipelineRow, repos: PipelineRepoRecord[]): PipelineRecord {
  const primary = firstInScopeRepo(repos);
  return {
    issueId: row.issue_id,
    currentPhase: row.current_phase,
    priorPhase: row.prior_phase,
    branchName: primary?.branchName ?? null,
    prNumber: primary?.prNumber ?? null,
    prBaseBranch: primary?.prBaseBranch ?? null,
    terminalPrNumber: primary?.terminalPrNumber ?? null,
    worktreePath: primary?.worktreePath ?? null,
    reviewIterations: row.review_iterations,
    feedbackIterations: row.feedback_iterations,
    specContent: row.spec_content,
    priorContext: row.prior_context,
    delegatorAccountId: row.delegator_account_id,
    openQuestionCount: row.open_question_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    repos,
  };
}
