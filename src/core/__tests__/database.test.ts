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
    const record = new PipelineStateStore(migratedDb.db).get("PROJ-1");

    expect(record?.terminalPrNumber).toBe(42);
    expect(record?.prBaseBranch).toBeNull();
    migratedDb.close();
  });
});
