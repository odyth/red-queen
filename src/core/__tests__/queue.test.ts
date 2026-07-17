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

function seedPipelineState(issueId: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO pipeline_state (issue_id, current_phase, created_at, updated_at)
     VALUES (?, NULL, ?, ?)`,
  ).run(issueId, createdAt, createdAt);
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

    function dequeueAndClaim(): string | null | undefined {
      const task = queue.dequeue();
      if (task !== null) {
        queue.markWorking(task.id);
      }
      return task?.issueId;
    }

    it("orders by pipeline_state.created_at (older ticket first)", () => {
      // Seed pipeline rows with ascending created_at — A older than B older than C
      seedPipelineState("PROJ-A", "2026-01-01T00:00:00.000Z");
      seedPipelineState("PROJ-B", "2026-02-01T00:00:00.000Z");
      seedPipelineState("PROJ-C", "2026-03-01T00:00:00.000Z");
      // Enqueue in reverse-age order: C first, then B, then A
      queue.enqueue({ type: "coding", issueId: "PROJ-C" });
      queue.enqueue({ type: "coding", issueId: "PROJ-B" });
      queue.enqueue({ type: "coding", issueId: "PROJ-A" });

      // Dequeue order is still A, B, C because pipeline_state.created_at rules
      expect(dequeueAndClaim()).toBe("PROJ-A");
      expect(dequeueAndClaim()).toBe("PROJ-B");
      expect(dequeueAndClaim()).toBe("PROJ-C");
    });

    it("feedback on an older ticket preempts a newer ticket", () => {
      seedPipelineState("PROJ-OLD", "2026-01-01T00:00:00.000Z");
      seedPipelineState("PROJ-NEW", "2026-04-01T00:00:00.000Z");
      // Newer ticket gets enqueued first
      queue.enqueue({ type: "coding", issueId: "PROJ-NEW" });
      // Then feedback arrives on the older ticket — it should jump ahead
      queue.enqueue({ type: "code-feedback", issueId: "PROJ-OLD" });

      expect(dequeueAndClaim()).toBe("PROJ-OLD");
      expect(dequeueAndClaim()).toBe("PROJ-NEW");
    });

    it("falls back to tasks.created_at when no pipeline_state row exists", () => {
      // new-ticket tasks are enqueued before pipeline_state is created
      queue.enqueue({ type: "new-ticket", issueId: "PROJ-1" });
      queue.enqueue({ type: "new-ticket", issueId: "PROJ-2" });
      queue.enqueue({ type: "new-ticket", issueId: "PROJ-3" });

      // Should dequeue in insertion order since no pipeline_state rows exist
      expect(dequeueAndClaim()).toBe("PROJ-1");
      expect(dequeueAndClaim()).toBe("PROJ-2");
      expect(dequeueAndClaim()).toBe("PROJ-3");
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

  describe("requeueAllWorking", () => {
    it("flips only working rows and returns them", () => {
      const w1 = queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      const w2 = queue.enqueue({ type: "testing", issueId: "PROJ-2" });
      const readyTask = queue.enqueue({ type: "coding", issueId: "PROJ-3" });
      const doneTask = queue.enqueue({ type: "coding", issueId: "PROJ-4" });
      queue.markWorking(w1.id);
      queue.markWorking(w2.id);
      queue.markWorking(doneTask.id);
      queue.markComplete(doneTask.id, "done");

      const requeued = queue.requeueAllWorking();

      expect(requeued.map((t) => t.id).sort()).toEqual([w1.id, w2.id].sort());
      for (const id of [w1.id, w2.id]) {
        const updated = queue.getTask(id);
        expect(updated?.status).toBe("ready");
        expect(updated?.startedAt).toBeNull();
      }
      expect(queue.getTask(readyTask.id)?.status).toBe("ready");
      expect(queue.getTask(doneTask.id)?.status).toBe("complete");
    });

    it("returns [] and changes nothing when no working tasks exist", () => {
      const readyTask = queue.enqueue({ type: "coding", issueId: "PROJ-1" });
      const doneTask = queue.enqueue({ type: "coding", issueId: "PROJ-2" });
      queue.markWorking(doneTask.id);
      queue.markComplete(doneTask.id, "done");

      const requeued = queue.requeueAllWorking();

      expect(requeued).toEqual([]);
      expect(queue.getTask(readyTask.id)?.status).toBe("ready");
      expect(queue.getTask(doneTask.id)?.status).toBe("complete");
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
