import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { PipelineStateStore, OrchestratorStateStore } from "../pipeline-state.js";
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
    store = new PipelineStateStore(db);
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

  it("updates branch name", () => {
    store.create("PROJ-1");
    store.updateBranch("PROJ-1", "feature/PROJ-1-add-login");
    expect(store.get("PROJ-1")?.branchName).toBe("feature/PROJ-1-add-login");
  });

  it("updates PR number", () => {
    store.create("PROJ-1");
    store.updatePrNumber("PROJ-1", 42);
    expect(store.get("PROJ-1")?.prNumber).toBe(42);
  });

  it("updates worktree path", () => {
    store.create("PROJ-1");
    store.updateWorktreePath("PROJ-1", "/tmp/worktrees/PROJ-1");
    expect(store.get("PROJ-1")?.worktreePath).toBe("/tmp/worktrees/PROJ-1");

    store.updateWorktreePath("PROJ-1", null);
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
    const updated = store.updateBranchInfo("PROJ-1", {
      branchName: "feature/PROJ-1",
      prNumber: 42,
    });
    expect(updated.branchName).toBe("feature/PROJ-1");
    expect(updated.prNumber).toBe(42);
    expect(updated.worktreePath).toBeNull();

    const withWorktree = store.updateBranchInfo("PROJ-1", {
      worktreePath: "/tmp/worktree",
    });
    expect(withWorktree.branchName).toBe("feature/PROJ-1");
    expect(withWorktree.prNumber).toBe(42);
    expect(withWorktree.worktreePath).toBe("/tmp/worktree");
  });

  it("updateBranchInfo clears fields when null is explicitly set", () => {
    store.create("PROJ-1");
    store.updateBranchInfo("PROJ-1", { prNumber: 1, worktreePath: "/tmp/w" });
    const cleared = store.updateBranchInfo("PROJ-1", { prNumber: null, worktreePath: null });
    expect(cleared.prNumber).toBeNull();
    expect(cleared.worktreePath).toBeNull();
  });

  it("updateBranchInfo throws if record does not exist", () => {
    expect(() => store.updateBranchInfo("nope", { prNumber: 1 })).toThrow(/no pipeline record/);
  });

  it("updateBranchInfo with empty object is a no-op", () => {
    const record = store.create("PROJ-1");
    const updated = store.updateBranchInfo("PROJ-1", {});
    expect(updated.issueId).toBe(record.issueId);
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
