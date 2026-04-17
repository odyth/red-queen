import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { SqliteTaskQueue } from "../queue.js";
import { SCHEMA_SQL } from "../database.js";

let db: BetterSqlite3.Database;
let queue: SqliteTaskQueue;

function createTestDb(): BetterSqlite3.Database {
  const rawDb = new Database(":memory:");
  rawDb.pragma("journal_mode = WAL");
  rawDb.exec(SCHEMA_SQL);
  return rawDb;
}

describe("SqliteTaskQueue", () => {
  beforeEach(() => {
    db = createTestDb();
    queue = new SqliteTaskQueue(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("enqueue + dequeue", () => {
    it("enqueues a task and dequeues it", () => {
      const task = queue.enqueue({ type: "spec-writing", issueId: "PROJ-1" });
      expect(task.type).toBe("spec-writing");
      expect(task.issueId).toBe("PROJ-1");
      expect(task.status).toBe("ready");
      expect(task.retryCount).toBe(0);

      const dequeued = queue.dequeue();
      expect(dequeued).not.toBeNull();
      expect(dequeued?.id).toBe(task.id);
    });

    it("returns null on empty queue", () => {
      const result = queue.dequeue();
      expect(result).toBeNull();
    });

    it("respects priority ordering (lower = higher priority)", () => {
      queue.enqueue({ type: "coding", issueId: "PROJ-1" }); // priority = 0 (first in empty queue)
      queue.enqueue({ type: "testing", issueId: "PROJ-2" }); // priority = 1
      queue.enqueue({ type: "spec-feedback", issueId: "PROJ-3", priority: 0 }); // jumps to front

      const first = queue.dequeue();
      expect(first?.type).toBe("spec-feedback");
      expect(first?.issueId).toBe("PROJ-3");
    });

    it("priority 0 always inserts at front", () => {
      queue.enqueue({ type: "a", issueId: "1" });
      queue.enqueue({ type: "b", issueId: "2" });
      queue.enqueue({ type: "c", issueId: "3" });
      queue.enqueue({ type: "urgent", issueId: "4", priority: 0 });

      const first = queue.dequeue();
      expect(first?.type).toBe("urgent");
    });

    it("no priority appends to end", () => {
      queue.enqueue({ type: "first", issueId: "1" });
      queue.enqueue({ type: "second", issueId: "2" });
      queue.enqueue({ type: "third", issueId: "3" });

      const first = queue.dequeue();
      expect(first?.type).toBe("first");
    });

    it("stores and retrieves metadata", () => {
      const task = queue.enqueue({
        type: "coding",
        issueId: "PROJ-1",
        metadata: { retryReason: "timeout", attempt: 2 },
      });

      const retrieved = queue.getTask(task.id);
      expect(retrieved?.metadata).toEqual({ retryReason: "timeout", attempt: 2 });
    });

    it("defaults metadata to empty object", () => {
      const task = queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      expect(task.metadata).toEqual({});
    });
  });

  describe("lifecycle transitions", () => {
    it("markWorking transitions ready -> working", () => {
      const task = queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      const result = queue.markWorking(task.id);
      expect(result).toBe(true);

      const updated = queue.getTask(task.id);
      expect(updated?.status).toBe("working");
      expect(updated?.startedAt).not.toBeNull();
    });

    it("markComplete transitions working -> complete", () => {
      const task = queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      queue.markWorking(task.id);
      const result = queue.markComplete(task.id, "Success: PR #42 created");
      expect(result).toBe(true);

      const updated = queue.getTask(task.id);
      expect(updated?.status).toBe("complete");
      expect(updated?.result).toBe("Success: PR #42 created");
      expect(updated?.completedAt).not.toBeNull();
    });

    it("markFailed transitions working -> failed and increments retryCount", () => {
      const task = queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      queue.markWorking(task.id);
      const result = queue.markFailed(task.id, "Worker timeout");
      expect(result).toBe(true);

      const updated = queue.getTask(task.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.result).toBe("Worker timeout");
      expect(updated?.retryCount).toBe(1);
    });

    it("markWorking fails on non-ready task", () => {
      const task = queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      queue.markWorking(task.id);
      const result = queue.markWorking(task.id);
      expect(result).toBe(false);
    });

    it("markComplete fails on non-working task", () => {
      const task = queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      const result = queue.markComplete(task.id, "done");
      expect(result).toBe(false);
    });
  });

  describe("dedup", () => {
    it("detects open task for same issue+type", () => {
      queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      expect(queue.hasOpenTask("PROJ-1", "coding")).toBe(true);
    });

    it("does not match different issue", () => {
      queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      expect(queue.hasOpenTask("PROJ-2", "coding")).toBe(false);
    });

    it("does not match different type", () => {
      queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      expect(queue.hasOpenTask("PROJ-1", "testing")).toBe(false);
    });

    it("detects working task as open", () => {
      const task = queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      queue.markWorking(task.id);
      expect(queue.hasOpenTask("PROJ-1", "coding")).toBe(true);
    });

    it("completed task is not open", () => {
      const task = queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      queue.markWorking(task.id);
      queue.markComplete(task.id, "done");
      expect(queue.hasOpenTask("PROJ-1", "coding")).toBe(false);
    });
  });

  describe("listByStatus", () => {
    it("lists tasks by status", () => {
      const t1 = queue.enqueue({ type: "a", issueId: "1" });
      queue.enqueue({ type: "b", issueId: "2" });
      queue.markWorking(t1.id);

      const ready = queue.listByStatus("ready");
      expect(ready).toHaveLength(1);
      expect(ready[0]?.type).toBe("b");

      const working = queue.listByStatus("working");
      expect(working).toHaveLength(1);
      expect(working[0]?.type).toBe("a");
    });
  });

  describe("purgeOld", () => {
    it("purges completed tasks older than threshold", () => {
      const task = queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      queue.markWorking(task.id);
      queue.markComplete(task.id, "done");

      // Backdate the completed_at to 10 days ago
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE tasks SET completed_at = ? WHERE id = ?").run(tenDaysAgo, task.id);

      const purged = queue.purgeOld(7);
      expect(purged).toBe(1);
      expect(queue.getTask(task.id)).toBeNull();
    });

    it("keeps recent completed tasks", () => {
      const task = queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      queue.markWorking(task.id);
      queue.markComplete(task.id, "done");

      const purged = queue.purgeOld(7);
      expect(purged).toBe(0);
      expect(queue.getTask(task.id)).not.toBeNull();
    });

    it("does not purge ready or working tasks", () => {
      queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      const t2 = queue.enqueue({ type: "testing", issueId: "PROJ-2" });
      queue.markWorking(t2.id);

      const purged = queue.purgeOld(0);
      expect(purged).toBe(0);
    });
  });

  describe("getTask", () => {
    it("returns null for nonexistent task", () => {
      expect(queue.getTask("nonexistent")).toBeNull();
    });
  });
});
