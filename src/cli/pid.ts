import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { resolve } from "node:path";

export function resolvePidPath(projectDir: string): string {
  return resolve(projectDir, ".redqueen", "redqueen.pid");
}

export type ClaimPidResult = { ok: true } | { ok: false; existingPid: number; stale: boolean };

/**
 * Atomically claim a PID file. Fails if the file already exists.
 * On conflict, reports the existing PID and whether the holder is alive.
 * Caller decides whether to clear a stale file and retry.
 */
export function tryClaimPidFile(path: string): ClaimPidResult {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o644);
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      const existingPid = readPidFile(path);
      if (existingPid === null) {
        return { ok: false, existingPid: 0, stale: true };
      }
      return { ok: false, existingPid, stale: isProcessAlive(existingPid) === false };
    }
    throw err;
  }
  try {
    writeSync(fd, `${String(process.pid)}\n`, 0, "utf8");
  } finally {
    closeSync(fd);
  }
  return { ok: true };
}

export function readPidFile(path: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
  const pid = Number.parseInt(raw, 10);
  if (Number.isNaN(pid) || pid <= 0) {
    return null;
  }
  return pid;
}

export function removePidFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      return false;
    }
    // EPERM etc. — process exists but we can't signal it
    return true;
  }
}
