import { spawn, execSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";

export interface HeartbeatInfo {
  pid: number;
  elapsed: number;
  cpuPercent: string;
  rssKb: string;
  cpuTime: string;
  idleSeconds: number;
}

export interface WorkerResult {
  success: boolean;
  exitCode: number;
  elapsed: number;
  summary: string;
  error: string | null;
}

export interface WorkerOptions {
  claudeBin: string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  stallThresholdMs: number;
  model: string;
  effort: string;
  heartbeatIntervalMs?: number;
  stallGracePeriodMs?: number;
  killGracePeriodMs?: number;
  maxBufferBytes?: number;
  onHeartbeat?: (info: HeartbeatInfo) => void;
  onStart?: (pid: number) => void;
}

const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_STALL_GRACE_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 10_000;
const CPU_CHANGE_THRESHOLD_SEC = 1.0;
const SUMMARY_MAX_LEN = 500;
const ERROR_MAX_LEN = 500;
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const TRUNCATION_MARKER = "\n...[output truncated]...\n";

export function resolveClaudeBin(configOverride?: string): string | null {
  if (configOverride !== undefined && configOverride !== "") {
    return pathIsExecutable(configOverride) ? configOverride : null;
  }
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(delimiter);
  for (const dir of parts) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, "claude");
    if (pathIsExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function pathIsExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  return new Promise<WorkerResult>((resolve) => {
    const startTime = Date.now();
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    const stallGracePeriodMs = options.stallGracePeriodMs ?? DEFAULT_STALL_GRACE_MS;
    const killGracePeriodMs = options.killGracePeriodMs ?? DEFAULT_KILL_GRACE_MS;
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

    const args = [
      "-p",
      options.prompt,
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--model",
      options.model,
      "--effort",
      options.effort,
    ];

    const worker = spawn(options.claudeBin, args, {
      cwd: options.cwd,
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killed = false;
    let killReason: string | null = null;

    worker.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      if (stdout.length + chunk.length <= maxBufferBytes) {
        stdout += chunk;
        return;
      }
      if (stdoutTruncated === false) {
        stdoutTruncated = true;
        const headRoom = maxBufferBytes - stdout.length;
        if (headRoom > 0) {
          stdout += chunk.substring(0, headRoom);
        }
        stdout += TRUNCATION_MARKER;
      }
    });
    worker.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      if (stderr.length + chunk.length <= maxBufferBytes) {
        stderr += chunk;
        return;
      }
      if (stderrTruncated === false) {
        stderrTruncated = true;
        const headRoom = maxBufferBytes - stderr.length;
        if (headRoom > 0) {
          stderr += chunk.substring(0, headRoom);
        }
        stderr += TRUNCATION_MARKER;
      }
    });

    if (options.onStart && worker.pid !== undefined) {
      options.onStart(worker.pid);
    }

    let lastCpuTime: number | null = null;
    let lastMeaningfulWorkAt = Date.now();

    const heartbeat = setInterval(() => {
      if (worker.pid === undefined) {
        return;
      }
      const snapshot = readProcessStats(worker.pid);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (snapshot === null) {
        return;
      }
      const idleSeconds = Math.round((Date.now() - lastMeaningfulWorkAt) / 1000);
      if (options.onHeartbeat) {
        options.onHeartbeat({
          pid: worker.pid,
          elapsed,
          cpuPercent: snapshot.cpuPercent,
          rssKb: snapshot.rssKb,
          cpuTime: snapshot.cpuTime,
          idleSeconds,
        });
      }

      const cpuTimeSecs = snapshot.cpuTimeSecs;
      if (elapsed * 1000 > stallGracePeriodMs && lastCpuTime !== null) {
        const cpuDelta = cpuTimeSecs - lastCpuTime;
        if (cpuDelta >= CPU_CHANGE_THRESHOLD_SEC) {
          lastMeaningfulWorkAt = Date.now();
        }
        if (Date.now() - lastMeaningfulWorkAt > options.stallThresholdMs) {
          killed = true;
          killReason = `Worker stalled (no CPU work for ${String(idleSeconds)}s)`;
          terminateWorker(worker, killGracePeriodMs);
        }
      }
      lastCpuTime = cpuTimeSecs;
    }, heartbeatIntervalMs);

    const timeoutTimer = setTimeout(() => {
      killed = true;
      killReason = `Worker timeout (${String(Math.round(options.timeoutMs / 1000))}s)`;
      terminateWorker(worker, killGracePeriodMs);
    }, options.timeoutMs);

    worker.on("close", (code) => {
      clearInterval(heartbeat);
      clearTimeout(timeoutTimer);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const exitCode = code ?? -1;

      if (exitCode === 0 && killed === false) {
        const summary = extractSummary(stdout);
        resolve({ success: true, exitCode, elapsed, summary, error: null });
        return;
      }

      let error: string;
      if (killReason !== null) {
        error = killReason;
      } else if (stderr.length > 0) {
        error = truncate(stderr, ERROR_MAX_LEN);
      } else {
        error = `Exit code ${String(exitCode)}`;
      }
      resolve({
        success: false,
        exitCode,
        elapsed,
        summary: extractSummary(stdout),
        error,
      });
    });

    worker.on("error", (err: Error) => {
      clearInterval(heartbeat);
      clearTimeout(timeoutTimer);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      resolve({
        success: false,
        exitCode: -1,
        elapsed,
        summary: "",
        error: err.message,
      });
    });
  });
}

function terminateWorker(worker: ReturnType<typeof spawn>, killGracePeriodMs: number): void {
  signalWorker(worker, "SIGTERM");
  setTimeout(() => {
    signalWorker(worker, "SIGKILL");
  }, killGracePeriodMs);
}

function signalWorker(worker: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  const pid = worker.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    try {
      worker.kill(signal);
    } catch {
      // Process already exited
    }
    return;
  }
  try {
    // Negative PID targets the whole process group so grandchildren (shell tools,
    // git, npm, MCP servers) don't linger after the worker itself is killed.
    process.kill(-pid, signal);
  } catch {
    try {
      worker.kill(signal);
    } catch {
      // Process already exited
    }
  }
}

interface ProcessStats {
  cpuPercent: string;
  rssKb: string;
  cpuTime: string;
  cpuTimeSecs: number;
}

function readProcessStats(pid: number): ProcessStats | null {
  if (process.platform === "win32") {
    return null;
  }
  try {
    const out = execSync(`ps -o %cpu,rss,cputime -p ${String(pid)}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const lines = out.split("\n");
    const lastLine = lines[lines.length - 1]?.trim() ?? "";
    if (lastLine === "") {
      return null;
    }
    const fields = lastLine.split(/\s+/);
    if (fields.length < 3) {
      return null;
    }
    const cpuPercent = fields[0] ?? "0";
    const rssKb = fields[1] ?? "0";
    const cpuTime = fields[2] ?? "0:00";
    return {
      cpuPercent,
      rssKb,
      cpuTime,
      cpuTimeSecs: parseCpuTime(cpuTime),
    };
  } catch {
    return null;
  }
}

function parseCpuTime(timeStr: string): number {
  const trimmed = timeStr.trim();
  const parts = trimmed.split(":").map((p) => parseFloat(p));
  if (parts.length === 3) {
    return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  }
  if (parts.length === 2) {
    return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  }
  return parts[0] ?? 0;
}

function extractSummary(stdout: string): string {
  if (stdout.length === 0) {
    return "Completed (no output)";
  }
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const raw =
        typeof obj.result === "string"
          ? obj.result
          : typeof obj.text === "string"
            ? obj.text
            : null;
      if (raw !== null) {
        return truncate(raw, SUMMARY_MAX_LEN);
      }
    }
  } catch {
    // Fall through to raw stdout handling
  }
  return truncate(stdout, SUMMARY_MAX_LEN);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.substring(0, max)}...`;
}
