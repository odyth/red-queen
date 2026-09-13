import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import {
  PipelineStateStore,
  OrchestratorStateStore,
  classifyRepoMergeTransition,
} from "../pipeline-state.js";
import { SCHEMA_SQL } from "../database.js";

let db: BetterSqlite3.Database;
let store: PipelineStateStore;
let orchStore: OrchestratorStateStore;

function createTestDb(): BetterSqlite3.Database {
  const rawDb = new Database(":memory:");
  rawDb.pragma("journal_mode = WAL");
  rawDb.exec(SCHEMA_SQL);
  return rawDb;
}

describe("PipelineStateStore", () => {
  beforeEach(() => {
    db = createTestDb();
    store = new PipelineStateStore(db, ["app", "web"]);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a pipeline record with null defaults", () => {
    const record = store.create("PROJ-1");
    expect(record.issueId).toBe("PROJ-1");
    expect(record.currentPhase).toBeNull();
    expect(record.branchName).toBeNull();
    expect(record.prNumber).toBeNull();
    expect(record.prBaseBranch).toBeNull();
    expect(record.terminalPrNumber).toBeNull();
    expect(record.reviewIterations).toBe(0);
    expect(record.feedbackIterations).toBe(0);
  });

  it("creates with an initial phase", () => {
    const record = store.create("PROJ-1", "spec-writing");
    expect(record.currentPhase).toBe("spec-writing");
  });

  it("creates with a delegator accountId", () => {
    const record = store.create("PROJ-1", "spec-writing", "human-123");
    expect(record.delegatorAccountId).toBe("human-123");
  });

  it("creates with null delegator when omitted", () => {
    const record = store.create("PROJ-1", "spec-writing");
    expect(record.delegatorAccountId).toBeNull();
  });

  it("updateDelegator sets and clears the account id", () => {
    store.create("PROJ-1");
    expect(store.updateDelegator("PROJ-1", "human-42")).toBe(true);
    expect(store.get("PROJ-1")?.delegatorAccountId).toBe("human-42");

    expect(store.updateDelegator("PROJ-1", "human-99")).toBe(true);
    expect(store.get("PROJ-1")?.delegatorAccountId).toBe("human-99");

    expect(store.updateDelegator("PROJ-1", null)).toBe(true);
    expect(store.get("PROJ-1")?.delegatorAccountId).toBeNull();
  });

  it("updateDelegator returns false for nonexistent issue", () => {
    expect(store.updateDelegator("nope", "x")).toBe(false);
  });

  it("returns null for nonexistent issue", () => {
    expect(store.get("nonexistent")).toBeNull();
  });

  it("updates phase", () => {
    store.create("PROJ-1", "spec-writing");
    const updated = store.updatePhase("PROJ-1", "coding");
    expect(updated).toBe(true);
    expect(store.get("PROJ-1")?.currentPhase).toBe("coding");
  });

  it("create leaves prior_phase null", () => {
    const record = store.create("PROJ-1", "coding");
    expect(record.priorPhase).toBeNull();
  });

  it("updatePhase shifts the outgoing phase into prior_phase", () => {
    store.create("PROJ-1", "coding");

    store.updatePhase("PROJ-1", "code-review");
    let record = store.get("PROJ-1");
    expect(record?.currentPhase).toBe("code-review");
    expect(record?.priorPhase).toBe("coding");

    store.updatePhase("PROJ-1", "coding");
    record = store.get("PROJ-1");
    expect(record?.currentPhase).toBe("coding");
    expect(record?.priorPhase).toBe("code-review");
  });

  it("markDone records the terminal PR identity for safe re-entry", () => {
    store.create("PROJ-1", "human-review");
    store.updateBranchInfo("PROJ-1", "app", {
      prNumber: 42,
      prBaseBranch: "main",
    });

    expect(store.markDone("PROJ-1")).toBe(true);
    let record = store.get("PROJ-1");
    expect(record?.currentPhase).toBe("done");
    expect(record?.priorPhase).toBe("human-review");
    expect(record?.prNumber).toBe(42);
    expect(record?.terminalPrNumber).toBe(42);

    store.updatePhase("PROJ-1", "coding");
    record = store.get("PROJ-1");
    expect(record?.terminalPrNumber).toBe(42);

    store.updateBranchInfo("PROJ-1", "app", { prNumber: 43 });
    record = store.get("PROJ-1");
    expect(record?.prNumber).toBe(43);
    expect(record?.terminalPrNumber).toBe(42);
  });

  it("markDone is idempotent and preserves the real prior phase", () => {
    store.create("PROJ-1", "coding");

    expect(store.markDone("PROJ-1")).toBe(true);
    expect(store.markDone("PROJ-1")).toBe(true);

    const record = store.get("PROJ-1");
    expect(record?.currentPhase).toBe("done");
    expect(record?.priorPhase).toBe("coding");
  });

  it("markPrMerged records an event PR that was never persisted locally", () => {
    store.create("PROJ-1", "coding");
    store.updateBranchInfo("PROJ-1", "app", {
      branchName: "feature/PROJ-1",
      prBaseBranch: "main",
      worktreePath: "/tmp/worktree",
    });

    expect(store.markPrMerged("PROJ-1", "app", 77)).toBe("processed");

    const record = store.get("PROJ-1");
    expect(record?.currentPhase).toBe("done");
    expect(record?.priorPhase).toBe("coding");
    expect(record?.terminalPrNumber).toBe(77);
    expect(record?.prNumber).toBeNull();
    expect(record?.prBaseBranch).toBeNull();
    expect(record?.branchName).toBe("feature/PROJ-1");
    expect(record?.worktreePath).toBe("/tmp/worktree");
  });

  it("markPrMerged rejects stale PRs and recognizes duplicate processing", () => {
    store.create("PROJ-1", "coding");
    store.updateBranchInfo("PROJ-1", "app", { prNumber: 77, prBaseBranch: "main" });

    expect(store.markPrMerged("PROJ-1", "app", 76)).toBe("stale");
    expect(store.get("PROJ-1")?.currentPhase).toBe("coding");

    expect(store.markPrMerged("PROJ-1", "app", 77)).toBe("processed");
    expect(store.markPrMerged("PROJ-1", "app", 77)).toBe("already-processed");
    expect(store.get("PROJ-1")?.priorPhase).toBe("coding");
  });

  it("markPrMerged reports missing records", () => {
    expect(store.markPrMerged("PROJ-404", "app", 77)).toBe("missing");
  });

  it("resetIterations leaves prior_phase intact", () => {
    store.create("PROJ-1", "coding");
    store.updatePhase("PROJ-1", "code-review");
    store.incrementReviewIterations("PROJ-1");
    expect(store.resetIterations("PROJ-1")).toBe(true);
    const record = store.get("PROJ-1");
    expect(record?.reviewIterations).toBe(0);
    expect(record?.priorPhase).toBe("coding");
  });

  it("updates branch name", () => {
    store.create("PROJ-1");
    store.updateBranch("PROJ-1", "app", "feature/PROJ-1-add-login");
    expect(store.get("PROJ-1")?.branchName).toBe("feature/PROJ-1-add-login");
  });

  it("updates PR number", () => {
    store.create("PROJ-1");
    store.updatePrNumber("PROJ-1", "app", 42, null);
    expect(store.get("PROJ-1")?.prNumber).toBe(42);
  });

  it("updates worktree path", () => {
    store.create("PROJ-1");
    store.updateWorktreePath("PROJ-1", "app", "/tmp/worktrees/PROJ-1");
    expect(store.get("PROJ-1")?.worktreePath).toBe("/tmp/worktrees/PROJ-1");

    store.updateWorktreePath("PROJ-1", "app", null);
    expect(store.get("PROJ-1")?.worktreePath).toBeNull();
  });

  it("increments review iterations", () => {
    store.create("PROJ-1");
    expect(store.incrementReviewIterations("PROJ-1")).toBe(1);
    expect(store.incrementReviewIterations("PROJ-1")).toBe(2);
    expect(store.incrementReviewIterations("PROJ-1")).toBe(3);
    expect(store.get("PROJ-1")?.reviewIterations).toBe(3);
  });

  it("increments feedback iterations", () => {
    store.create("PROJ-1");
    expect(store.incrementFeedbackIterations("PROJ-1")).toBe(1);
    expect(store.incrementFeedbackIterations("PROJ-1")).toBe(2);
    expect(store.get("PROJ-1")?.feedbackIterations).toBe(2);
  });

  it("resetIterations zeros both review and feedback counters", () => {
    store.create("PROJ-1");
    store.incrementReviewIterations("PROJ-1");
    store.incrementReviewIterations("PROJ-1");
    store.incrementFeedbackIterations("PROJ-1");
    expect(store.resetIterations("PROJ-1")).toBe(true);
    const record = store.get("PROJ-1");
    expect(record?.reviewIterations).toBe(0);
    expect(record?.feedbackIterations).toBe(0);
  });

  it("resetIterations returns false when no record exists", () => {
    expect(store.resetIterations("PROJ-NOBODY")).toBe(false);
  });

  it("resetReviewIterations zeros review counter only, leaving feedback intact", () => {
    store.create("PROJ-1");
    store.incrementReviewIterations("PROJ-1");
    store.incrementReviewIterations("PROJ-1");
    store.incrementFeedbackIterations("PROJ-1");
    expect(store.resetReviewIterations("PROJ-1")).toBe(true);
    const record = store.get("PROJ-1");
    expect(record?.reviewIterations).toBe(0);
    expect(record?.feedbackIterations).toBe(1);
  });

  it("resetReviewIterations returns false when no record exists", () => {
    expect(store.resetReviewIterations("PROJ-NOBODY")).toBe(false);
  });

  it("updates spec content", () => {
    store.create("PROJ-1");
    store.updateSpec("PROJ-1", "# Login Feature Spec\n\nRequirements...");
    expect(store.get("PROJ-1")?.specContent).toBe("# Login Feature Spec\n\nRequirements...");
  });

  it("updates prior context", () => {
    store.create("PROJ-1");
    store.updatePriorContext(
      "PROJ-1",
      "Added retry logic — reviewer should focus on error handling",
    );
    expect(store.get("PROJ-1")?.priorContext).toBe(
      "Added retry logic — reviewer should focus on error handling",
    );
  });

  it("deletes a record", () => {
    store.create("PROJ-1");
    expect(store.delete("PROJ-1")).toBe(true);
    expect(store.get("PROJ-1")).toBeNull();
  });

  it("delete returns false for nonexistent", () => {
    expect(store.delete("nonexistent")).toBe(false);
  });

  it("lists all records ordered by updatedAt desc", () => {
    store.create("PROJ-1", "spec-writing");
    store.create("PROJ-2", "coding");
    // Update PROJ-1 to make it most recent
    store.updatePhase("PROJ-1", "spec-review");

    const all = store.listAll();
    expect(all).toHaveLength(2);
    expect(all[0]?.issueId).toBe("PROJ-1");
    expect(all[1]?.issueId).toBe("PROJ-2");
  });

  it("update returns false for nonexistent issue", () => {
    expect(store.updatePhase("nonexistent", "coding")).toBe(false);
  });

  it("updateBranchInfo applies partial updates atomically", () => {
    store.create("PROJ-1");
    const updated = store.updateBranchInfo("PROJ-1", "app", {
      branchName: "feature/PROJ-1",
      prNumber: 42,
      prBaseBranch: "main",
    });
    expect(updated.branchName).toBe("feature/PROJ-1");
    expect(updated.prNumber).toBe(42);
    expect(updated.prBaseBranch).toBe("main");
    expect(updated.worktreePath).toBeNull();

    const withWorktree = store.updateBranchInfo("PROJ-1", "app", {
      worktreePath: "/tmp/worktree",
    });
    expect(withWorktree.branchName).toBe("feature/PROJ-1");
    expect(withWorktree.prNumber).toBe(42);
    expect(withWorktree.worktreePath).toBe("/tmp/worktree");
  });

  it("updateBranchInfo clears fields when null is explicitly set", () => {
    store.create("PROJ-1");
    store.updateBranchInfo("PROJ-1", "app", {
      prNumber: 1,
      prBaseBranch: "main",
      worktreePath: "/tmp/w",
    });
    const cleared = store.updateBranchInfo("PROJ-1", "app", {
      prNumber: null,
      prBaseBranch: null,
      worktreePath: null,
    });
    expect(cleared.prNumber).toBeNull();
    expect(cleared.prBaseBranch).toBeNull();
    expect(cleared.worktreePath).toBeNull();
  });

  it("updateBranchInfo throws if record does not exist", () => {
    expect(() => store.updateBranchInfo("nope", "app", { prNumber: 1 })).toThrow(
      /no pipeline record/,
    );
  });

  it("updateBranchInfo with empty object is a no-op", () => {
    const record = store.create("PROJ-1");
    const updated = store.updateBranchInfo("PROJ-1", "app", {});
    expect(updated.issueId).toBe(record.issueId);
  });

  it("creates with null openQuestionCount", () => {
    const record = store.create("PROJ-1");
    expect(record.openQuestionCount).toBeNull();
  });

  it("setOpenQuestionCount stores a value and reads it back", () => {
    store.create("PROJ-1");
    expect(store.setOpenQuestionCount("PROJ-1", 0)).toBe(true);
    expect(store.get("PROJ-1")?.openQuestionCount).toBe(0);

    expect(store.setOpenQuestionCount("PROJ-1", 5)).toBe(true);
    expect(store.get("PROJ-1")?.openQuestionCount).toBe(5);
  });

  it("setOpenQuestionCount accepts null to clear", () => {
    store.create("PROJ-1");
    store.setOpenQuestionCount("PROJ-1", 3);
    expect(store.setOpenQuestionCount("PROJ-1", null)).toBe(true);
    expect(store.get("PROJ-1")?.openQuestionCount).toBeNull();
  });

  it("setOpenQuestionCount returns false for nonexistent issue", () => {
    expect(store.setOpenQuestionCount("nope", 0)).toBe(false);
  });

  it("resetIterations also clears openQuestionCount", () => {
    store.create("PROJ-1");
    store.setOpenQuestionCount("PROJ-1", 0);
    store.incrementReviewIterations("PROJ-1");
    expect(store.resetIterations("PROJ-1")).toBe(true);
    const record = store.get("PROJ-1");
    expect(record?.reviewIterations).toBe(0);
    expect(record?.openQuestionCount).toBeNull();
  });
});

describe("OrchestratorStateStore", () => {
  beforeEach(() => {
    db = createTestDb();
    orchStore = new OrchestratorStateStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("initializes with defaults", () => {
    const state = orchStore.get();
    expect(state.status).toBe("stopped");
    expect(state.currentTaskId).toBeNull();
    expect(state.lastPoll).toBeNull();
    expect(state.completedCount).toBe(0);
    expect(state.errorCount).toBe(0);
    expect(state.startedAt).toBeNull();
  });

  it("updates status", () => {
    orchStore.setStatus("working");
    expect(orchStore.get().status).toBe("working");
  });

  it("tracks current task", () => {
    orchStore.setCurrentTaskId("task-abc123");
    expect(orchStore.get().currentTaskId).toBe("task-abc123");

    orchStore.setCurrentTaskId(null);
    expect(orchStore.get().currentTaskId).toBeNull();
  });

  it("increments counters", () => {
    orchStore.incrementCompleted();
    orchStore.incrementCompleted();
    orchStore.incrementErrors();

    const state = orchStore.get();
    expect(state.completedCount).toBe(2);
    expect(state.errorCount).toBe(1);
  });

  it("resets to defaults", () => {
    orchStore.setStatus("working");
    orchStore.incrementCompleted();
    orchStore.reset();

    const state = orchStore.get();
    expect(state.status).toBe("stopped");
    expect(state.completedCount).toBe(0);
  });

  it("sets lastPoll and startedAt", () => {
    const now = new Date().toISOString();
    orchStore.setLastPoll(now);
    orchStore.setStartedAt(now);

    const state = orchStore.get();
    expect(state.lastPoll).toBe(now);
    expect(state.startedAt).toBe(now);
  });
});

describe("PipelineStateStore pipeline_repos", () => {
  beforeEach(() => {
    db = createTestDb();
    store = new PipelineStateStore(db, ["app", "web"]);
  });
  afterEach(() => {
    db.close();
  });

  it("starts with no repo rows and null scalars", () => {
    const record = store.create("PROJ-1", "spec-writing");
    expect(record.repos).toEqual([]);
    expect(record.branchName).toBeNull();
    expect(record.prNumber).toBeNull();
  });

  it("setScope upserts in-scope rows in config order and descopes the rest", () => {
    store.create("PROJ-1");
    const rows = store.setScope("PROJ-1", ["web", "app"]);
    expect(rows.map((r) => [r.repo, r.inScope])).toEqual([
      ["app", true],
      ["web", true],
    ]);
    const after = store.setScope("PROJ-1", ["web"]);
    expect(after.map((r) => [r.repo, r.inScope])).toEqual([
      ["app", false],
      ["web", true],
    ]);
  });

  it("descoping a row with an open PR keeps its branch, PR, and worktree", () => {
    store.create("PROJ-1");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updateBranchInfo("PROJ-1", "app", {
      branchName: "feature/PROJ-1",
      prNumber: 7,
      prBaseBranch: "main",
      worktreePath: "/w/app",
    });
    store.setScope("PROJ-1", ["web"]);
    const app = store.getRepo("PROJ-1", "app");
    expect(app?.inScope).toBe(false);
    expect(app?.prNumber).toBe(7);
    expect(app?.branchName).toBe("feature/PROJ-1");
    expect(app?.worktreePath).toBe("/w/app");
  });

  it("mirrors the first in-scope row into the pipeline_state scalars", () => {
    store.create("PROJ-1");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updatePrNumber("PROJ-1", "web", 5, "main");
    store.updatePrNumber("PROJ-1", "app", 9, "main");
    expect(store.get("PROJ-1")?.prNumber).toBe(9);
    const raw = db
      .prepare("SELECT pr_number, pr_base_branch FROM pipeline_state WHERE issue_id = ?")
      .get("PROJ-1") as { pr_number: number | null; pr_base_branch: string | null };
    expect(raw).toEqual({ pr_number: 9, pr_base_branch: "main" });
    store.setScope("PROJ-1", ["web"]);
    expect(store.get("PROJ-1")?.prNumber).toBe(5);
  });

  it("updateBranchInfo on an unknown row upserts it in scope", () => {
    store.create("PROJ-1");
    const row = store.updateBranchInfo("PROJ-1", "web", { branchName: "b" });
    expect(row.inScope).toBe(true);
    expect(row.branchName).toBe("b");
  });

  it("updateBranchInfo throws when the pipeline record is missing", () => {
    expect(() => store.updateBranchInfo("nope", "app", { branchName: "b" })).toThrow(
      /no pipeline record/,
    );
  });

  it("markPrMerged marks done only when the last in-scope PR merges", () => {
    store.create("PROJ-1", "human-review");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updatePrNumber("PROJ-1", "app", 1, "main");
    store.updatePrNumber("PROJ-1", "web", 2, "main");

    expect(store.markPrMerged("PROJ-1", "app", 1)).toBe("pending-others");
    expect(store.get("PROJ-1")?.currentPhase).toBe("human-review");
    expect(store.getRepo("PROJ-1", "app")).toMatchObject({
      prNumber: null,
      terminalPrNumber: 1,
      prBaseBranch: null,
    });

    expect(store.markPrMerged("PROJ-1", "web", 2)).toBe("processed");
    const done = store.get("PROJ-1");
    expect(done?.currentPhase).toBe("done");
    expect(done?.priorPhase).toBe("human-review");
    expect(done?.terminalPrNumber).toBe(1);
  });

  it("markPrMerged on a descoped row transitions the row but never advances the issue", () => {
    store.create("PROJ-1", "human-review");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updatePrNumber("PROJ-1", "app", 1, "main");
    store.setScope("PROJ-1", ["web"]);
    expect(store.markPrMerged("PROJ-1", "app", 1)).toBe("pending-others");
    expect(store.get("PROJ-1")?.currentPhase).toBe("human-review");
    expect(store.getRepo("PROJ-1", "app")?.terminalPrNumber).toBe(1);
  });

  it("waits for an in-scope sibling that has not produced a PR yet", () => {
    store.create("PROJ-1", "human-review");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updatePrNumber("PROJ-1", "app", 1, "main");

    expect(store.markPrMerged("PROJ-1", "app", 1)).toBe("pending-others");
    expect(store.get("PROJ-1")?.currentPhase).toBe("human-review");
    expect(store.getRepo("PROJ-1", "app")?.mergeCompleted).toBe(true);
    expect(store.getRepo("PROJ-1", "web")?.mergeCompleted).toBe(false);

    store.updatePrNumber("PROJ-1", "web", 2, "main");
    expect(store.markPrMerged("PROJ-1", "web", 2)).toBe("processed");
  });

  it("retains replay identity but requires fresh merges after reopening a completed issue", () => {
    store.create("PROJ-1", "human-review");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updatePrNumber("PROJ-1", "app", 1, "main");
    store.updatePrNumber("PROJ-1", "web", 2, "main");
    store.markPrMerged("PROJ-1", "app", 1);
    store.markPrMerged("PROJ-1", "web", 2);
    store.updatePhase("PROJ-1", "coding");

    expect(store.getRepo("PROJ-1", "app")).toMatchObject({
      terminalPrNumber: 1,
      mergeCompleted: false,
    });
    expect(store.markPrMerged("PROJ-1", "app", 1)).toBe("stale");
    store.updatePrNumber("PROJ-1", "web", 3, "main");
    expect(store.markPrMerged("PROJ-1", "web", 2)).toBe("stale");
    expect(store.markPrMerged("PROJ-1", "web", 3)).toBe("pending-others");
    expect(store.get("PROJ-1")?.currentPhase).toBe("coding");
    store.updatePrNumber("PROJ-1", "app", 4, "main");
    expect(store.markPrMerged("PROJ-1", "app", 4)).toBe("processed");
  });

  it("counts a numberless merge only for its own row", () => {
    store.create("PROJ-1", "coding");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updateBranch("PROJ-1", "app", "feature/app");
    expect(store.markPrMerged("PROJ-1", "app", null)).toBe("pending-others");
    expect(store.getRepo("PROJ-1", "app")).toMatchObject({
      terminalPrNumber: null,
      mergeCompleted: true,
    });
    expect(store.markPrMerged("PROJ-1", "app", null)).toBe("already-processed");
    store.updatePrNumber("PROJ-1", "web", 2, "main");
    expect(store.markPrMerged("PROJ-1", "web", 2)).toBe("processed");
  });

  it("preserves partial merge completion through cleanup and feedback, but not a new PR", () => {
    store.create("PROJ-1", "human-review");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updateBranchInfo("PROJ-1", "app", { branchName: "feature/app", prNumber: 1 });
    store.markPrMerged("PROJ-1", "app", 1);
    store.updateBranchInfo("PROJ-1", "app", { branchName: null, worktreePath: null });
    store.updatePhase("PROJ-1", "code-feedback");
    expect(store.getRepo("PROJ-1", "app")?.mergeCompleted).toBe(true);
    expect(store.markPrMerged("PROJ-1", "app", 1)).toBe("already-processed");

    store.updatePrNumber("PROJ-1", "app", 3, "main");
    expect(store.getRepo("PROJ-1", "app")).toMatchObject({
      terminalPrNumber: 1,
      mergeCompleted: false,
    });
    expect(store.markPrMerged("PROJ-1", "app", 1)).toBe("stale");
  });

  it("markDone keeps earlier partial merge evidence without claiming unmerged PRs completed", () => {
    store.create("PROJ-1", "human-review");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updatePrNumber("PROJ-1", "app", 1, "main");
    store.updatePrNumber("PROJ-1", "web", 2, "main");
    store.markPrMerged("PROJ-1", "app", 1);
    store.markDone("PROJ-1");
    expect(store.getRepo("PROJ-1", "app")).toMatchObject({
      terminalPrNumber: 1,
      mergeCompleted: true,
    });
    expect(store.getRepo("PROJ-1", "web")).toMatchObject({
      prNumber: 2,
      terminalPrNumber: 2,
      mergeCompleted: false,
    });
    expect(store.markPrMerged("PROJ-1", "web", 2)).toBe("processed");
  });

  it("markPrMerged reports duplicates and stale PRs per row", () => {
    store.create("PROJ-1", "human-review");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updatePrNumber("PROJ-1", "app", 1, "main");
    store.updatePrNumber("PROJ-1", "web", 2, "main");
    store.markPrMerged("PROJ-1", "app", 1);
    expect(store.markPrMerged("PROJ-1", "app", 1)).toBe("already-processed");
    expect(store.markPrMerged("PROJ-1", "web", 99)).toBe("stale");
    expect(store.markPrMerged("PROJ-1", "nope", 1)).toBe("missing");
    expect(store.markPrMerged("nope", "app", 1)).toBe("missing");
  });

  it("rejects a different PR replay after a partial merge without changing any state", () => {
    store.create("PROJ-1", "human-review");
    store.setScope("PROJ-1", ["app", "web"]);
    store.updatePrNumber("PROJ-1", "app", 1, "main");
    store.markPrMerged("PROJ-1", "app", 1);
    const before = store.get("PROJ-1");

    expect(store.markPrMerged("PROJ-1", "app", 99)).toBe("stale");
    expect(store.get("PROJ-1")).toEqual(before);
  });

  it("classifies partial merge duplicates independently of the issue phase", () => {
    const row = { prNumber: null, terminalPrNumber: 1, mergeCompleted: true };
    expect(classifyRepoMergeTransition("human-review", row, 1)).toBe("already-processed");
    expect(classifyRepoMergeTransition("human-review", row, null)).toBe("already-processed");
    expect(classifyRepoMergeTransition("human-review", row, 99)).toBe("stale");
  });

  it("findByPr resolves the issue by repo and PR number", () => {
    store.create("PROJ-1");
    store.create("PROJ-2");
    store.updatePrNumber("PROJ-1", "app", 10, "main");
    store.updatePrNumber("PROJ-2", "web", 10, "main");
    expect(store.findByPr("web", 10)?.issueId).toBe("PROJ-2");
    expect(store.findByPr("app", 11)).toBeNull();
  });

  it("markDone records terminal PR numbers per in-scope row and keeps pr_number", () => {
    store.create("PROJ-1", "human-review");
    store.updatePrNumber("PROJ-1", "app", 3, "main");
    store.markDone("PROJ-1");
    expect(store.getRepo("PROJ-1", "app")).toMatchObject({ prNumber: 3, terminalPrNumber: 3 });
    expect(store.get("PROJ-1")?.terminalPrNumber).toBe(3);
  });

  it("delete removes repo rows too", () => {
    store.create("PROJ-1");
    store.updateBranch("PROJ-1", "app", "b");
    store.delete("PROJ-1");
    expect(db.prepare("SELECT COUNT(*) AS c FROM pipeline_repos").get()).toEqual({ c: 0 });
  });

  it("listAll attaches repo rows to every record", () => {
    store.create("PROJ-1");
    store.create("PROJ-2");
    store.updateBranch("PROJ-2", "web", "b");
    const all = store.listAll();
    expect(all.find((r) => r.issueId === "PROJ-2")?.repos.map((r) => r.repo)).toEqual(["web"]);
    expect(all.find((r) => r.issueId === "PROJ-1")?.repos).toEqual([]);
  });
});

describe("PipelineStateStore.adoptLegacyRows", () => {
  beforeEach(() => {
    db = createTestDb();
    store = new PipelineStateStore(db, ["app"]);
  });
  afterEach(() => {
    db.close();
  });

  function insertLegacy(
    issueId: string,
    cols: Partial<
      Record<
        | "branch_name"
        | "pr_number"
        | "worktree_path"
        | "spec_content"
        | "terminal_pr_number"
        | "current_phase",
        string | number | null
      >
    >,
  ): void {
    const keys = Object.keys(cols);
    db.prepare(
      `INSERT INTO pipeline_state (issue_id, created_at, updated_at${keys.map((k) => `, ${k}`).join("")})
       VALUES (?, ?, ?${keys.map(() => ", ?").join("")})`,
    ).run(issueId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", ...Object.values(cols));
  }

  it("adopts rows with branch, PR, worktree, spec, or terminal PR into repos[0] and is idempotent", () => {
    insertLegacy("A", { branch_name: "feature/A", pr_number: 4, worktree_path: "/w/A" });
    insertLegacy("B", { spec_content: "spec" });
    insertLegacy("C", { current_phase: "done", terminal_pr_number: 8 });
    insertLegacy("D", {});
    expect(store.adoptLegacyRows("app").sort()).toEqual(["A", "B", "C"]);
    expect(store.adoptLegacyRows("app")).toEqual([]);
    expect(store.getRepo("A", "app")).toMatchObject({
      inScope: true,
      branchName: "feature/A",
      prNumber: 4,
      worktreePath: "/w/A",
    });
    expect(store.getRepo("B", "app")?.inScope).toBe(true);
    expect(store.getRepo("C", "app")?.terminalPrNumber).toBe(8);
    expect(store.listRepos("D")).toEqual([]);
    expect(store.get("A")?.prNumber).toBe(4);
  });

  it("skips issues that already have repo rows", () => {
    insertLegacy("A", { branch_name: "old" });
    store.updateBranch("A", "app", "new");
    expect(store.adoptLegacyRows("app")).toEqual([]);
    expect(store.getRepo("A", "app")?.branchName).toBe("new");
  });

  it("keeps modern spec-only rows unscoped unless explicitly running in legacy mode", () => {
    store.create("MODERN", "spec-writing");
    store.updateSpec("MODERN", "workspace spec before scope selection");

    expect(store.adoptLegacyRows("app")).toEqual([]);
    expect(store.get("MODERN")?.repos).toEqual([]);
    expect(store.adoptLegacyRows("app", true)).toEqual(["MODERN"]);
    expect(store.getRepo("MODERN", "app")?.inScope).toBe(true);
  });

  it("does not later adopt new workspace specs on pre-upgrade empty rows already seen at startup", () => {
    insertLegacy("EMPTY", {});
    expect(store.adoptLegacyRows("app")).toEqual([]);
    store.updateSpec("EMPTY", "new workspace spec before scope selection");
    expect(store.adoptLegacyRows("app")).toEqual([]);
    expect(store.get("EMPTY")?.repos).toEqual([]);
    expect(store.adoptLegacyRows("app", true)).toEqual(["EMPTY"]);
  });

  it("distinguishes a completed legacy merge from terminal history and an unmerged done PR", () => {
    insertLegacy("merged", { current_phase: "done", terminal_pr_number: 8 });
    insertLegacy("reopened", { current_phase: "coding", terminal_pr_number: 9 });
    insertLegacy("unmerged", { current_phase: "done", pr_number: 10, terminal_pr_number: 10 });
    store.adoptLegacyRows("app");

    expect(store.getRepo("merged", "app")?.mergeCompleted).toBe(true);
    expect(store.getRepo("reopened", "app")?.mergeCompleted).toBe(false);
    expect(store.getRepo("unmerged", "app")?.mergeCompleted).toBe(false);
    expect(store.markPrMerged("reopened", "app", 9)).toBe("stale");
    expect(store.markPrMerged("unmerged", "app", 10)).toBe("processed");

    store.updatePhase("merged", "coding");
    store.setScope("merged", ["app", "web"]);
    store.updatePrNumber("merged", "web", 11, "main");
    expect(store.markPrMerged("merged", "web", 11)).toBe("pending-others");
    expect(store.markPrMerged("merged", "app", 8)).toBe("stale");
    expect(store.get("merged")?.currentPhase).toBe("coding");
  });
});
