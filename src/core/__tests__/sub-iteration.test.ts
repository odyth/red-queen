import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { SCHEMA_SQL } from "../database.js";
import { StaleSubIterationError, SubIterationStore } from "../sub-iteration.js";

let db: BetterSqlite3.Database;
let store: SubIterationStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  store = new SubIterationStore(db);
});

afterEach(() => {
  db.close();
});

describe("SubIterationStore", () => {
  it("start inserts a new in-progress entry with index 0 on first call", () => {
    const sub = store.start({
      issueId: "PROJ-1",
      phaseName: "spec-writing",
      label: "Codebase research",
      now: "2026-05-19T00:00:00.000Z",
    });
    expect(sub.issueId).toBe("PROJ-1");
    expect(sub.phaseName).toBe("spec-writing");
    expect(sub.subIterIndex).toBe(0);
    expect(sub.label).toBe("Codebase research");
    expect(sub.status).toBe("in-progress");
    expect(sub.summary).toBeNull();
    expect(sub.startedAt).toBe("2026-05-19T00:00:00.000Z");
    expect(sub.completedAt).toBeNull();
  });

  it("start increments sub_iter_index per (issue, phase)", () => {
    const a = store.start({ issueId: "PROJ-1", phaseName: "spec-writing", label: "research" });
    const b = store.start({ issueId: "PROJ-1", phaseName: "spec-writing", label: "design" });
    expect(a.subIterIndex).toBe(0);
    expect(b.subIterIndex).toBe(1);
  });

  it("start indexes are per-phase, not global", () => {
    const a = store.start({ issueId: "PROJ-1", phaseName: "spec-writing", label: "research" });
    const b = store.start({ issueId: "PROJ-1", phaseName: "coding", label: "implement" });
    expect(a.subIterIndex).toBe(0);
    expect(b.subIterIndex).toBe(0);
  });

  it("start indexes are per-issue", () => {
    const a = store.start({ issueId: "PROJ-1", phaseName: "spec-writing", label: "research" });
    const b = store.start({ issueId: "PROJ-2", phaseName: "spec-writing", label: "research" });
    expect(a.subIterIndex).toBe(0);
    expect(b.subIterIndex).toBe(0);
  });

  it("completeLatestOpen closes the most recent open entry for the issue", () => {
    store.start({
      issueId: "PROJ-1",
      phaseName: "spec-writing",
      label: "research",
      now: "2026-05-19T00:00:00.000Z",
    });
    const second = store.start({
      issueId: "PROJ-1",
      phaseName: "spec-writing",
      label: "design",
      now: "2026-05-19T00:00:01.000Z",
    });
    const closed = store.completeLatestOpen({
      issueId: "PROJ-1",
      phaseName: "spec-writing",
      summary: "Picked module X",
      now: "2026-05-19T00:00:02.000Z",
    });
    expect(closed?.id).toBe(second.id);
    expect(closed?.status).toBe("completed");
    expect(closed?.summary).toBe("Picked module X");
    expect(closed?.completedAt).toBe("2026-05-19T00:00:02.000Z");

    // The earlier "research" entry is still open
    const all = store.listByIssue("PROJ-1");
    expect(all).toHaveLength(2);
    expect(all[0]?.status).toBe("in-progress");
    expect(all[1]?.status).toBe("completed");
  });

  it("completeLatestOpen returns null when no open entry exists", () => {
    const result = store.completeLatestOpen({
      issueId: "PROJ-MISSING",
      phaseName: "spec-writing",
      summary: "...",
    });
    expect(result).toBeNull();
  });

  it("completeLatestOpen skips already-completed entries", () => {
    store.start({ issueId: "PROJ-1", phaseName: "spec-writing", label: "research" });
    store.completeLatestOpen({
      issueId: "PROJ-1",
      phaseName: "spec-writing",
      summary: "done",
    });
    const second = store.completeLatestOpen({
      issueId: "PROJ-1",
      phaseName: "spec-writing",
      summary: "another",
    });
    expect(second).toBeNull();
  });

  it("completeLatestOpen throws StaleSubIterationError when latest open belongs to a different phase", () => {
    // Simulate a crashed spec-writing skill leaving a zombie open entry, then
    // a later coding phase trying to complete its own sub-iteration. The
    // store must refuse to silently close the zombie.
    store.start({
      issueId: "PROJ-1",
      phaseName: "spec-writing",
      label: "abandoned research",
      now: "2026-05-19T00:00:00.000Z",
    });
    expect(() =>
      store.completeLatestOpen({
        issueId: "PROJ-1",
        phaseName: "coding",
        summary: "implementation done",
        now: "2026-05-19T01:00:00.000Z",
      }),
    ).toThrow(StaleSubIterationError);
  });

  it("listByIssue returns rows ordered by started_at ascending", () => {
    store.start({
      issueId: "PROJ-1",
      phaseName: "spec-writing",
      label: "research",
      now: "2026-05-19T00:00:00.000Z",
    });
    store.start({
      issueId: "PROJ-1",
      phaseName: "spec-writing",
      label: "design",
      now: "2026-05-19T00:00:01.000Z",
    });
    const all = store.listByIssue("PROJ-1");
    expect(all.map((s) => s.label)).toEqual(["research", "design"]);
  });

  it("toRecord rejects rows with an invalid status value", () => {
    db.prepare(
      `INSERT INTO phase_sub_iterations
         (issue_id, phase_name, sub_iter_index, label, status, started_at)
       VALUES ('PROJ-1', 'spec-writing', 0, 'corrupt', 'mystery', '2026-05-19T00:00:00.000Z')`,
    ).run();
    expect(() => store.listByIssue("PROJ-1")).toThrow(/invalid status/);
  });
});
