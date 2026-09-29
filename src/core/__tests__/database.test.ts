import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedQueenDatabase, SCHEMA_SQL } from "../database.js";
import { PipelineStateStore } from "../pipeline-state.js";

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir !== null) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("RedQueenDatabase migrations", () => {
  it("adds phase retry state to existing handoffs and preserves backoff and notices on reopen", () => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-phase-retry-migration-"));
    const dbPath = join(tempDir, "redqueen.db");
    const legacyDb = new Database(dbPath);
    legacyDb.exec(
      SCHEMA_SQL.replace("    phase_attempts INTEGER NOT NULL DEFAULT 0,\n", "")
        .replace("    phase_retry_at INTEGER NOT NULL DEFAULT 0,\n", "")
        .replace("    phase_notice_posted INTEGER NOT NULL DEFAULT 0,\n", ""),
    );
    const legacyState = new PipelineStateStore(legacyDb);
    legacyState.create("PROJ-1", "coding");
    legacyState.beginPhaseTransition("PROJ-1", "coding", "blocked");
    legacyDb.close();

    const migrated = new RedQueenDatabase(dbPath);
    const state = new PipelineStateStore(migrated.db);
    const pending = state.getPendingTransition("PROJ-1");
    expect(pending).toMatchObject({
      phaseApplied: 0,
      phaseAttempts: 0,
      phaseRetryAt: 0,
      phaseNoticePosted: 0,
    });
    if (pending === null) {
      throw new Error("Missing migrated handoff");
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      state.recordPhaseFailure(pending, 12345);
    }
    state.markPhaseNoticePosted(pending);
    migrated.close();

    const reopened = new RedQueenDatabase(dbPath);
    expect(new PipelineStateStore(reopened.db).getPendingTransition("PROJ-1")).toMatchObject({
      id: pending.id,
      phaseApplied: 0,
      phaseAttempts: 3,
      phaseRetryAt: 12345,
      phaseNoticePosted: 1,
      assignmentAttempts: 0,
    });
    reopened.close();
  });

  it("preserves confirmed phase writes when upgrading old pending handoffs", () => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-handoff-migration-"));
    const dbPath = join(tempDir, "redqueen.db");
    const legacyDb = new Database(dbPath);
    legacyDb.exec(SCHEMA_SQL);
    const legacyState = new PipelineStateStore(legacyDb);
    legacyState.create("APPLIED", "blocked");
    legacyState.create("UNAPPLIED", "coding");
    legacyDb.exec(`DROP TABLE pending_phase_transitions;
      CREATE TABLE pending_phase_transitions (
        issue_id TEXT PRIMARY KEY REFERENCES pipeline_state(issue_id) ON DELETE CASCADE,
        source_phase TEXT NOT NULL, destination TEXT NOT NULL
      );
      INSERT INTO pending_phase_transitions VALUES ('APPLIED', 'coding', 'blocked');
      INSERT INTO pending_phase_transitions VALUES ('UNAPPLIED', 'coding', 'blocked');`);
    legacyDb.close();
    const migrated = new RedQueenDatabase(dbPath);
    const state = new PipelineStateStore(migrated.db);
    expect(state.getPendingTransition("APPLIED")?.phaseApplied).toBe(1);
    expect(state.getPendingTransition("UNAPPLIED")?.phaseApplied).toBe(0);
    const pending = state.getPendingTransition("APPLIED");
    if (pending === null) {
      throw new Error("Missing migrated handoff");
    }
    state.recordAssignmentFailure(pending, 12345);
    migrated.close();
    const reopened = new RedQueenDatabase(dbPath);
    expect(new PipelineStateStore(reopened.db).getPendingTransition("APPLIED")).toMatchObject({
      id: pending.id,
      phaseApplied: 1,
      assignmentAttempts: 1,
      assignmentRetryAt: 12345,
    });
    reopened.close();
  });
  it("adds recovery tables to old databases and preserves handoffs and counters on reopen", () => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-recovery-migration-"));
    const dbPath = join(tempDir, "redqueen.db");
    const legacyDb = new Database(dbPath);
    legacyDb.exec(SCHEMA_SQL);
    legacyDb.exec("DROP TABLE pending_phase_transitions; DROP TABLE phase_rework_counts;");
    new PipelineStateStore(legacyDb).create("PROJ-1", "testing");
    legacyDb.close();
    const migrated = new RedQueenDatabase(dbPath);
    const state = new PipelineStateStore(migrated.db);
    state.incrementPhaseReworks("PROJ-1", "testing");
    state.beginPhaseTransition("PROJ-1", "testing", "human-review");
    migrated.close();
    const reopened = new RedQueenDatabase(dbPath);
    const restored = new PipelineStateStore(reopened.db);
    expect(restored.incrementPhaseReworks("PROJ-1", "testing")).toBe(2);
    expect(restored.getPendingTransition("PROJ-1")).toMatchObject({
      issueId: "PROJ-1",
      sourcePhase: "testing",
      destination: "human-review",
      phaseApplied: 0,
      assignmentAttempts: 0,
      assignmentRetryAt: 0,
    });
    expect(restored.isPhaseExhausted("PROJ-1", "testing")).toBe(true);
    restored.delete("PROJ-1");
    expect(restored.listPendingTransitions()).toEqual([]);
    expect(reopened.db.prepare("SELECT * FROM phase_rework_counts").all()).toEqual([]);
    reopened.close();
  });
  it("adds durable phase exhaustion to existing databases", () => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-database-"));
    const dbPath = join(tempDir, "redqueen.db");
    const legacyDb = new Database(dbPath);
    legacyDb.exec(SCHEMA_SQL.replace("    exhausted_phase TEXT,\n", ""));
    new PipelineStateStore(legacyDb).create("PROJ-1", "coding");
    legacyDb.close();

    const migrated = new RedQueenDatabase(dbPath);
    const store = new PipelineStateStore(migrated.db);
    expect(store.isPhaseExhausted("PROJ-1", "coding")).toBe(false);
    store.setExhaustedPhase("PROJ-1", "coding");
    migrated.close();

    const reopened = new RedQueenDatabase(dbPath);
    expect(new PipelineStateStore(reopened.db).isPhaseExhausted("PROJ-1", "coding")).toBe(true);
    reopened.close();
  });

  it("keeps pre-upgrade spec-only rows eligible while persisting modern-row eligibility across restarts", () => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-database-"));
    const dbPath = join(tempDir, "redqueen.db");
    const legacyDb = new Database(dbPath);
    legacyDb.exec(SCHEMA_SQL.replace("    repo_state_version INTEGER NOT NULL DEFAULT 0,\n", ""));
    legacyDb
      .prepare(
        `INSERT INTO pipeline_state
      (issue_id, spec_content, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run("OLD", "old spec", "2026-01-01", "2026-01-01");
    legacyDb.close();

    const migrated = new RedQueenDatabase(dbPath);
    const store = new PipelineStateStore(migrated.db, ["app"]);
    store.create("NEW", "spec-writing");
    store.updateSpec("NEW", "new spec");
    migrated.close();

    const reopened = new RedQueenDatabase(dbPath);
    const reopenedStore = new PipelineStateStore(reopened.db, ["app"]);
    expect(reopenedStore.adoptLegacyRows("app")).toEqual(["OLD"]);
    expect(reopenedStore.get("NEW")?.repos).toEqual([]);
    expect(reopenedStore.getRepo("OLD", "app")?.inScope).toBe(true);
    reopened.close();
  });

  it("backfills the terminal PR marker for completed legacy records", () => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-database-"));
    const dbPath = join(tempDir, "redqueen.db");
    const legacySchema = SCHEMA_SQL.replace("    pr_base_branch TEXT,\n", "").replace(
      "    terminal_pr_number INTEGER,\n",
      "",
    );
    const legacyDb = new Database(dbPath);
    legacyDb.exec(legacySchema);
    legacyDb
      .prepare(
        `INSERT INTO pipeline_state
           (issue_id, current_phase, pr_number, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("PROJ-1", "done", 42, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    legacyDb.close();

    const migratedDb = new RedQueenDatabase(dbPath);
    const store = new PipelineStateStore(migratedDb.db);
    store.adoptLegacyRows(store.defaultRepo);
    const record = store.get("PROJ-1");

    expect(record?.terminalPrNumber).toBe(42);
    expect(record?.prBaseBranch).toBeNull();
    migratedDb.close();
  });

  it("keeps per-repo scalar mirrors read-only during the legacy terminal migration", () => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-database-"));
    const dbPath = join(tempDir, "redqueen.db");
    const original = new RedQueenDatabase(dbPath);
    const store = new PipelineStateStore(original.db, ["app"]);
    store.create("PROJ-1", "done");
    store.updatePrNumber("PROJ-1", "app", 42, null);
    original.close();

    const reopened = new RedQueenDatabase(dbPath);
    expect(
      reopened.db
        .prepare("SELECT terminal_pr_number FROM pipeline_state WHERE issue_id = ?")
        .get("PROJ-1"),
    ).toEqual({ terminal_pr_number: null });
    reopened.close();
  });
});

it("creates the pipeline_repos table and index on a fresh database", () => {
  tempDir = mkdtempSync(join(tmpdir(), "rq-database-"));
  const db = new RedQueenDatabase(join(tempDir, "redqueen.db"));
  const tables = db.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE 'pipeline_repos%' OR name = 'idx_pipeline_repos_pr'",
    )
    .all() as { name: string }[];
  expect(tables.map((t) => t.name).sort()).toEqual(["idx_pipeline_repos_pr", "pipeline_repos"]);
  db.close();
});
