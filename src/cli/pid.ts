import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function resolvePidPath(projectDir: string): string {
  return resolve(projectDir, ".redqueen", "redqueen.pid");
}

export function writePidFile(path: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${String(process.pid)}\n`, { encoding: "utf8", mode: 0o644 });
  renameSync(tmp, path);
}

export function readPidFile(path: string): number | null {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
  if (existsSync(path) === false) {
    return null;
  }
  const raw = readFileSync(path, "utf8").trim();
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
