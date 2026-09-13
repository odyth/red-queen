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
