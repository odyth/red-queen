import type BetterSqlite3 from "better-sqlite3";
import { appendFileSync } from "node:fs";

// --- Types ---

export interface AuditEntry {
  id?: number;
  timestamp: string;
  component: string;
  issueId: string | null;
  message: string;
  metadata: Record<string, unknown>;
}

export interface AuditFilter {
  issueId?: string;
  component?: string;
  since?: string;
  limit?: number;
}

// --- Interface ---

export interface AuditLogger {
  log(entry: Omit<AuditEntry, "timestamp">): void;
  query(filter: AuditFilter): AuditEntry[];
  prune(olderThanDays: number): number;
}

// --- SQLite row shape ---

interface AuditRow {
  id: number;
  timestamp: string;
  component: string;
  issue_id: string | null;
  message: string;
  metadata: string | null;
}

// --- Dual-write implementation ---

export class DualWriteAuditLogger implements AuditLogger {
  private readonly db: BetterSqlite3.Database;
  private readonly logFilePath: string;
  private readonly insertStmt: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database, logFilePath: string) {
    this.db = db;
    this.logFilePath = logFilePath;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        component TEXT NOT NULL,
        issue_id TEXT,
        message TEXT NOT NULL,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_issue_id ON audit_log(issue_id);
    `);

    this.insertStmt = this.db.prepare(
      "INSERT INTO audit_log (timestamp, component, issue_id, message, metadata) VALUES (?, ?, ?, ?, ?)",
    );
  }

  log(entry: Omit<AuditEntry, "timestamp">): void {
    const timestamp = new Date().toISOString();
    const metadataJson =
      Object.keys(entry.metadata).length > 0 ? JSON.stringify(entry.metadata) : null;

    // SQLite write
    this.insertStmt.run(timestamp, entry.component, entry.issueId, entry.message, metadataJson);

    // Flat file write
    const issueIdPart = entry.issueId ?? "-";
    const line = `[${timestamp}] ${entry.component} | ${issueIdPart} | ${entry.message}\n`;
    appendFileSync(this.logFilePath, line);
  }

  query(filter: AuditFilter): AuditEntry[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.issueId !== undefined) {
      conditions.push("issue_id = ?");
      params.push(filter.issueId);
    }
    if (filter.component !== undefined) {
      conditions.push("component = ?");
      params.push(filter.component);
    }
    if (filter.since !== undefined) {
      conditions.push("timestamp >= ?");
      params.push(filter.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit !== undefined ? `LIMIT ${String(filter.limit)}` : "";
    const sql = `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC ${limit}`;

    const rows = this.db.prepare(sql).all(...params) as AuditRow[];
    return rows.map(toAuditEntry);
  }

  prune(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare("DELETE FROM audit_log WHERE timestamp < ?").run(cutoff);
    return result.changes;
  }
}

function toAuditEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    component: row.component,
    issueId: row.issue_id,
    message: row.message,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {},
  };
}
