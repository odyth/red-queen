import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { loadConfig } from "../core/config.js";
import { findConfigUpward, projectRootFromConfigPath } from "./config-discovery.js";
import { CliError } from "./errors.js";
import { isProcessAlive, readPidFile, resolvePidPath } from "./pid.js";

interface StatusPayload {
  running: boolean;
  pid: number | null;
  source: "http" | "database" | "none";
  status: string;
  currentTaskId: string | null;
  lastPoll: string | null;
  completedCount: number;
  errorCount: number;
  startedAt: string | null;
  readyCount: number;
  workingCount: number;
  currentTask: unknown;
  note: string | null;
}

export async function cmdStatus(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help === true) {
    process.stdout.write(
      "redqueen status — show orchestrator status (use --json for machine-readable output)\n",
    );
    return;
  }

  const configPath = findConfigUpward(process.cwd());
  if (configPath === null) {
    throw new CliError(`redqueen.yaml not found (searched from ${process.cwd()} upward)`);
  }

  const config = loadConfig(configPath);
  const projectRoot = projectRootFromConfigPath(configPath);
  const projectDir = resolve(projectRoot, config.project.directory);
  const pidPath = resolvePidPath(projectDir);
  const pid = readPidFile(pidPath);
  const alive = pid !== null && isProcessAlive(pid);

  const dbPath = resolve(projectDir, ".redqueen", "redqueen.db");

  let payload: StatusPayload;
  if (alive) {
    const fromHttp = await tryHttp(config.dashboard.host, config.dashboard.port);
    if (fromHttp !== null) {
      payload = { ...fromHttp, running: true, pid, source: "http", note: null };
    } else if (existsSync(dbPath)) {
      const fromDb = readFromDatabase(dbPath);
      payload = {
        ...fromDb,
        running: true,
        pid,
        source: "database",
        note: "Dashboard unreachable — falling back to SQLite snapshot.",
      };
    } else {
      payload = emptyPayload("Red Queen is running but database is missing.");
      payload.pid = pid;
      payload.running = true;
    }
  } else if (existsSync(dbPath)) {
    const fromDb = readFromDatabase(dbPath);
    payload = { ...fromDb, running: false, pid: null, source: "database", note: null };
  } else {
    payload = emptyPayload("Red Queen has not been started yet.");
  }

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  printHuman(payload);
}

async function tryHttp(
  host: string,
  port: number,
): Promise<Omit<StatusPayload, "running" | "pid" | "source" | "note"> | null> {
  try {
    const res = await fetch(`http://${host}:${String(port)}/api/status`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok === false) {
      return null;
    }
    const body = (await res.json()) as Record<string, unknown>;
    const rawStatus = body.status;
    return {
      status: typeof rawStatus === "string" ? rawStatus : "unknown",
      currentTaskId: (body.currentTaskId as string | null) ?? null,
      lastPoll: (body.lastPoll as string | null) ?? null,
      completedCount: Number(body.completedCount ?? 0),
      errorCount: Number(body.errorCount ?? 0),
      startedAt: (body.startedAt as string | null) ?? null,
      readyCount: Number(body.readyCount ?? 0),
      workingCount: Number(body.workingCount ?? 0),
      currentTask: body.currentTask ?? null,
    };
  } catch {
    return null;
  }
}

function readFromDatabase(
  dbPath: string,
): Omit<StatusPayload, "running" | "pid" | "source" | "note"> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT key, value FROM orchestrator_state").all() as {
      key: string;
      value: string | null;
    }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const countByStatus = (status: string): number => {
      const r = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = ?").get(status) as {
        c: number;
      };
      return r.c;
    };
    return {
      status: map.get("status") ?? "stopped",
      currentTaskId: map.get("current_task_id") ?? null,
      lastPoll: map.get("last_poll") ?? null,
      completedCount: Number(map.get("completed_count") ?? "0"),
      errorCount: Number(map.get("error_count") ?? "0"),
      startedAt: map.get("started_at") ?? null,
      readyCount: countByStatus("ready"),
      workingCount: countByStatus("working"),
      currentTask: null,
    };
  } finally {
    db.close();
  }
}

function emptyPayload(note: string): StatusPayload {
  return {
    running: false,
    pid: null,
    source: "none",
    status: "stopped",
    currentTaskId: null,
    lastPoll: null,
    completedCount: 0,
    errorCount: 0,
    startedAt: null,
    readyCount: 0,
    workingCount: 0,
    currentTask: null,
    note,
  };
}

function printHuman(p: StatusPayload): void {
  if (p.running) {
    process.stdout.write(`Red Queen — running\n`);
  } else {
    process.stdout.write(`Red Queen — not running\n`);
  }
  if (p.pid !== null) {
    process.stdout.write(`  pid:         ${String(p.pid)}\n`);
  }
  process.stdout.write(`  status:      ${p.status}\n`);
  if (p.currentTaskId !== null) {
    process.stdout.write(`  current:     ${p.currentTaskId}\n`);
  }
  process.stdout.write(
    `  queue:       ${String(p.readyCount)} ready, ${String(p.workingCount)} working\n`,
  );
  process.stdout.write(`  completed:   ${String(p.completedCount)}\n`);
  process.stdout.write(`  errors:      ${String(p.errorCount)}\n`);
  if (p.startedAt !== null) {
    process.stdout.write(`  started at:  ${p.startedAt}\n`);
  }
  if (p.lastPoll !== null) {
    process.stdout.write(`  last poll:   ${p.lastPoll}\n`);
  }
  if (p.note !== null) {
    process.stdout.write(`  note:        ${p.note}\n`);
  }
}
