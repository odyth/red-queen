import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { DualWriteAuditLogger } from "../audit.js";

let db: BetterSqlite3.Database;
let logger: DualWriteAuditLogger;
let tempDir: string;
let logFilePath: string;

describe("DualWriteAuditLogger", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-audit-test-"));
    logFilePath = join(tempDir, "audit.log");
    db = new Database(":memory:");
    logger = new DualWriteAuditLogger(db, logFilePath);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("log", () => {
    it("writes to both SQLite and flat file", () => {
      logger.log({
        component: "orchestrator",
        issueId: "PROJ-1",
        message: "Task dispatched: spec-writing",
        metadata: { taskId: "abc123" },
      });

      const entries = logger.query({});
      expect(entries).toHaveLength(1);
      expect(entries[0]?.component).toBe("orchestrator");
      expect(entries[0]?.issueId).toBe("PROJ-1");
      expect(entries[0]?.message).toBe("Task dispatched: spec-writing");
      expect(entries[0]?.metadata).toEqual({ taskId: "abc123" });

      const fileContent = readFileSync(logFilePath, "utf-8");
      expect(fileContent).toContain("orchestrator | PROJ-1 | Task dispatched: spec-writing");
    });

    it("handles null issueId", () => {
      logger.log({
        component: "webhook",
        issueId: null,
        message: "Server started on port 4400",
        metadata: {},
      });

      const entries = logger.query({});
      expect(entries[0]?.issueId).toBeNull();

      const fileContent = readFileSync(logFilePath, "utf-8");
      expect(fileContent).toContain("webhook | - | Server started on port 4400");
    });

    it("handles empty metadata", () => {
      logger.log({
        component: "adapter",
        issueId: "PROJ-1",
        message: "Phase updated",
        metadata: {},
      });

      const entries = logger.query({});
      expect(entries[0]?.metadata).toEqual({});
    });
  });

  describe("query", () => {
    beforeEach(() => {
      logger.log({
        component: "orchestrator",
        issueId: "PROJ-1",
        message: "Task started",
        metadata: {},
      });
      logger.log({
        component: "adapter",
        issueId: "PROJ-1",
        message: "Phase set to coding",
        metadata: {},
      });
      logger.log({
        component: "orchestrator",
        issueId: "PROJ-2",
        message: "Task started",
        metadata: {},
      });
    });

    it("filters by issueId", () => {
      const entries = logger.query({ issueId: "PROJ-1" });
      expect(entries).toHaveLength(2);
    });

    it("filters by component", () => {
      const entries = logger.query({ component: "orchestrator" });
      expect(entries).toHaveLength(2);
    });

    it("filters by both", () => {
      const entries = logger.query({ component: "orchestrator", issueId: "PROJ-1" });
      expect(entries).toHaveLength(1);
    });

    it("applies limit", () => {
      const entries = logger.query({ limit: 1 });
      expect(entries).toHaveLength(1);
    });

    it("filters by since", () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const entries = logger.query({ since: future });
      expect(entries).toHaveLength(0);
    });

    it("returns results in descending timestamp order", () => {
      const entries = logger.query({});
      expect(entries).toHaveLength(3);
      // Most recent first
      expect(entries[0]?.issueId).toBe("PROJ-2");
    });
  });

  describe("prune", () => {
    it("removes entries older than threshold", () => {
      logger.log({
        component: "orchestrator",
        issueId: "PROJ-1",
        message: "Old entry",
        metadata: {},
      });

      // Backdate the entry
      const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE audit_log SET timestamp = ?").run(thirtyOneDaysAgo);

      const pruned = logger.prune(30);
      expect(pruned).toBe(1);
      expect(logger.query({})).toHaveLength(0);
    });

    it("keeps recent entries", () => {
      logger.log({
        component: "orchestrator",
        issueId: "PROJ-1",
        message: "Recent entry",
        metadata: {},
      });

      const pruned = logger.prune(30);
      expect(pruned).toBe(0);
      expect(logger.query({})).toHaveLength(1);
    });
  });
});
