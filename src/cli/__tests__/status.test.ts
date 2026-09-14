import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { RedQueenDatabase } from "../../core/database.js";
import { PipelineStateStore } from "../../core/pipeline-state.js";
import { cmdStatus } from "../status.js";

interface StatusOutput {
  running: boolean;
  source: string;
  status: string;
  completedCount: number;
  readyCount: number;
  currentTask: unknown;
  note: string | null;
  pipelines: {
    issueId: string;
    currentPhase: string | null;
    repos: {
      repo: string;
      inScope: boolean;
      branchName: string | null;
      prNumber: number | null;
      orphaned: boolean;
    }[];
  }[];
}

let tmp: string;
let dbPath: string;
let originalCwd: string;
let out: string[];

function readOutput(): StatusOutput {
  return JSON.parse(out.join("")) as StatusOutput;
}

function writeRunningPid(): void {
  writeFileSync(join(tmp, ".redqueen", "redqueen.pid"), String(process.pid));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rq-status-"));
  originalCwd = process.cwd();
  writeFileSync(
    join(tmp, "redqueen.yaml"),
    `issueTracker:
  type: mock
sourceControl:
  type: mock
project:
  repos:
    - name: web
      path: repos/web
      owner: acme
      repo: web
      buildCommand: b
      testCommand: t
    - name: api
      path: repos/api
      owner: acme
      repo: api
      buildCommand: b
      testCommand: t
`,
  );
  mkdirSync(join(tmp, "repos", "web", ".git"), { recursive: true });
  mkdirSync(join(tmp, "repos", "api", ".git"), { recursive: true });
  mkdirSync(join(tmp, ".redqueen"));
  dbPath = join(tmp, ".redqueen", "redqueen.db");
  process.chdir(tmp);
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("cmdStatus pipelines", () => {
  it("lists configured repos in order, retains unknown repos, and flags orphaned PRs", async () => {
    const db = new RedQueenDatabase(dbPath);
    const store = new PipelineStateStore(db.db, ["web", "api"]);
    store.create("PROJ-1", "coding");
    store.setScope("PROJ-1", ["old-z", "api", "old-a", "web"]);
    store.updateBranchInfo("PROJ-1", "web", { branchName: "feature/PROJ-1", prNumber: 3 });
    store.updateBranchInfo("PROJ-1", "old-a", { branchName: "feature/PROJ-1", prNumber: 9 });
    store.setScope("PROJ-1", ["api", "web"]);
    db.close();

    await cmdStatus(["--json"]);
    expect(readOutput()).toMatchObject({ running: false, source: "database" });
    expect(readOutput().pipelines).toEqual([
      {
        issueId: "PROJ-1",
        currentPhase: "coding",
        repos: [
          {
            repo: "web",
            inScope: true,
            branchName: "feature/PROJ-1",
            prNumber: 3,
            orphaned: false,
          },
          { repo: "api", inScope: true, branchName: null, prNumber: null, orphaned: false },
          {
            repo: "old-a",
            inScope: false,
            branchName: "feature/PROJ-1",
            prNumber: 9,
            orphaned: true,
          },
          { repo: "old-z", inScope: false, branchName: null, prNumber: null, orphaned: false },
        ],
      },
    ]);

    out = [];
    await cmdStatus([]);
    expect(out.join("")).toContain("PROJ-1  coding");
    expect(out.join("")).toMatch(/old-a\s+feature\/PROJ-1\s+PR #9\s+ORPHANED/);
    expect(out.join("")).toContain("descoped; close or merge manually");
    expect(out.join("")).toMatch(/old-z\s+—\s+—\s+\(descoped\)/);
  });

  it("includes tickets with only descoped rows and renders a missing phase", async () => {
    const db = new RedQueenDatabase(dbPath);
    const store = new PipelineStateStore(db.db);
    store.create("PROJ-ORPHAN");
    store.updateBranchInfo("PROJ-ORPHAN", "api", { prNumber: 5 });
    store.setScope("PROJ-ORPHAN", []);
    db.close();

    await cmdStatus(["--json"]);
    expect(readOutput().pipelines).toEqual([
      {
        issueId: "PROJ-ORPHAN",
        currentPhase: null,
        repos: [{ repo: "api", inScope: false, branchName: null, prNumber: 5, orphaned: true }],
      },
    ]);
    out = [];
    await cmdStatus([]);
    expect(out.join("")).toContain("PROJ-ORPHAN  (no phase)");
  });

  it("omits zero-row records before limiting the newest 50 and includes completed tickets", async () => {
    const db = new RedQueenDatabase(dbPath);
    const store = new PipelineStateStore(db.db);
    const setUpdatedAt = db.db.prepare(
      "UPDATE pipeline_state SET updated_at = ? WHERE issue_id = ?",
    );
    for (let index = 0; index < 55; index++) {
      const issueId = `PROJ-${String(index)}`;
      store.create(issueId, index % 2 === 0 ? "done" : "coding");
      store.setScope(issueId, ["api"]);
      if (index === 54) {
        store.setScope(issueId, []);
      }
      setUpdatedAt.run(new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), issueId);
    }
    store.create("PROJ-EMPTY", "spec-writing");
    setUpdatedAt.run("2026-12-01T00:00:00.000Z", "PROJ-EMPTY");
    db.close();

    await cmdStatus(["--json"]);
    const pipelines = readOutput().pipelines;
    expect(pipelines).toHaveLength(50);
    expect(pipelines.map((pipeline) => pipeline.issueId)).toEqual(
      Array.from({ length: 50 }, (_, index) => `PROJ-${String(54 - index)}`),
    );
    expect(pipelines[0]).toMatchObject({ currentPhase: "done", repos: [{ inScope: false }] });
  });

  it("combines live HTTP status with repo rows from a database still open in WAL mode", async () => {
    const db = new RedQueenDatabase(dbPath);
    try {
      const store = new PipelineStateStore(db.db);
      store.create("PROJ-LIVE", "human-review");
      store.updateBranchInfo("PROJ-LIVE", "web", { prNumber: 7 });
      writeRunningPid();
      const fetchStatus = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          status: "working",
          completedCount: 42,
          readyCount: 8,
          currentTask: { id: "live-task" },
          pipelines: [{ issueId: "HTTP-DATA-IS-NOT-THE-SOURCE" }],
        }),
      );
      vi.stubGlobal("fetch", fetchStatus);

      await cmdStatus(["--json"]);
      expect(fetchStatus).toHaveBeenCalledOnce();
      expect(readOutput()).toMatchObject({
        running: true,
        source: "http",
        status: "working",
        completedCount: 42,
        readyCount: 8,
        currentTask: { id: "live-task" },
        note: null,
        pipelines: [
          { issueId: "PROJ-LIVE", currentPhase: "human-review", repos: [{ prNumber: 7 }] },
        ],
      });
      expect(readOutput().pipelines).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("includes repo rows in the running database fallback", async () => {
    const db = new RedQueenDatabase(dbPath);
    const store = new PipelineStateStore(db.db);
    store.create("PROJ-FALLBACK", "coding");
    store.setScope("PROJ-FALLBACK", ["api"]);
    db.close();
    writeRunningPid();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("unreachable")));

    await cmdStatus(["--json"]);
    expect(readOutput()).toMatchObject({
      running: true,
      source: "database",
      note: "Dashboard unreachable — falling back to SQLite snapshot.",
      pipelines: [{ issueId: "PROJ-FALLBACK" }],
    });
  });

  it.each([false, true])(
    "returns an empty list without a database (running=%s)",
    async (running) => {
      if (running) {
        writeRunningPid();
        vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({})));
      }
      await cmdStatus(["--json"]);
      expect(readOutput()).toMatchObject({ running, pipelines: [] });
    },
  );

  it("reads pre-workspace databases without creating repo tables or migrating the file", async () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE orchestrator_state (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO orchestrator_state VALUES ('status', 'stopped'), ('completed_count', '12');
      CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT);
      INSERT INTO tasks VALUES ('legacy-task', 'ready');
      CREATE TABLE pipeline_state (
        issue_id TEXT PRIMARY KEY,
        current_phase TEXT,
        branch_name TEXT,
        pr_number INTEGER,
        updated_at TEXT
      );
      INSERT INTO pipeline_state VALUES ('PROJ-OLD', 'coding', 'feature/old', 4, '2026-01-01');
    `);
    db.close();
    const originalBytes = readFileSync(dbPath);

    await cmdStatus(["--json"]);
    expect(readOutput()).toMatchObject({
      running: false,
      source: "database",
      completedCount: 12,
      readyCount: 1,
      pipelines: [],
    });
    expect(readFileSync(dbPath)).toEqual(originalBytes);
    const readonlyDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      expect(
        readonlyDb.prepare("SELECT name FROM sqlite_master WHERE name = 'pipeline_repos'").get(),
      ).toBeUndefined();
    } finally {
      readonlyDb.close();
    }
  });
});
