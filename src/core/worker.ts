import { spawn, execSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import type { RunUsage, WorkerAgent, WorkerEffort } from "./types.js";

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
  usage: RunUsage | null;
  // Claude Code's own total_cost_usd for the run, when emitted. Present even on
  // a Max subscription (the equivalent API list price). null when absent.
  reportedCostUsd: number | null;
}

export interface WorkerOptions {
  bin: string;
  // Which CLI `bin` is. Selects arg building and output parsing; omitted means
  // claude-code so pre-existing callers keep working.
  agent?: WorkerAgent;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  stallThresholdMs: number;
  // null omits the model flag entirely — the CLI's own config decides.
  model: string | null;
  effort: string;
  heartbeatIntervalMs?: number;
  stallGracePeriodMs?: number;
  killGracePeriodMs?: number;
  maxBufferBytes?: number;
  onHeartbeat?: (info: HeartbeatInfo) => void;
  onStart?: (pid: number) => void;
  // Aborting terminates the worker (SIGTERM → SIGKILL after the grace period),
  // routed through the same kill path as timeout/stall. The orchestrator aborts
  // when the ticket is moved out of the phase this worker is running.
  signal?: AbortSignal;
}

const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_STALL_GRACE_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 10_000;
const CPU_CHANGE_THRESHOLD_SEC = 1.0;
const SUMMARY_MAX_LEN = 2000;
const ERROR_MAX_LEN = 2000;
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const TRUNCATION_MARKER = "\n...[output truncated]...\n";

export function resolveClaudeBin(configOverride?: string): string | null {
  return resolveBin("claude", configOverride);
}

export function resolveAgentBin(
  agent: WorkerAgent,
  pipeline: { claudeBin?: string; codexBin?: string },
): string | null {
  return agent === "codex"
    ? resolveBin("codex", pipeline.codexBin)
    : resolveBin("claude", pipeline.claudeBin);
}

function resolveBin(binaryName: string, configOverride?: string): string | null {
  if (configOverride !== undefined && configOverride !== "") {
    return pathIsExecutable(configOverride) ? configOverride : null;
  }
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(delimiter);
  for (const dir of parts) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, binaryName);
    if (pathIsExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

export interface ResolvedAgentSettings {
  agent: WorkerAgent;
  model: string | null;
  effort: string;
}

// Phase-over-pipeline resolution for the worker's agent/model/effort. Model
// names are agent-specific, so the pipeline model only inherits when the
// resolved agent matches the pipeline agent — a phase that switches agents
// falls back to that agent's default (claude-code → "opus", codex → null,
// meaning ~/.codex/config.toml decides).
export function resolveAgentSettings(
  pipeline: { agent: WorkerAgent; model?: string; effort: string },
  phase: { agent?: WorkerAgent; model?: string; effort?: WorkerEffort },
): ResolvedAgentSettings {
  const agent = phase.agent ?? pipeline.agent;
  const inherited = agent === pipeline.agent ? pipeline.model : undefined;
  const model = phase.model ?? inherited ?? (agent === "claude-code" ? "opus" : null);
  return { agent, model, effort: phase.effort ?? pipeline.effort };
}

function pathIsExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Each CLI's non-interactive invocation. Effort is clamped to the resolved
// agent's supported scale here — the one place that knows which CLI the
// string feeds. Both branches run unattended with full permissions: claude's
// bypassPermissions ≙ codex's danger-full-access (skills need git push/npm),
// and claude's --no-session-persistence ≙ codex's --ephemeral.
export function buildWorkerArgs(options: WorkerOptions): string[] {
  const agent = options.agent ?? "claude-code";
  if (agent === "codex") {
    const effort = options.effort === "max" ? "xhigh" : options.effort;
    const modelArgs = options.model === null ? [] : ["-m", options.model];
    return [
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      "danger-full-access",
      "-c",
      `model_reasoning_effort=${effort}`,
      ...modelArgs,
      options.prompt,
    ];
  }
  const effort = options.effort === "minimal" ? "low" : options.effort;
  const modelArgs = options.model === null ? [] : ["--model", options.model];
  return [
    "-p",
    options.prompt,
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "json",
    "--no-session-persistence",
    ...modelArgs,
    "--effort",
    effort,
  ];
}

export function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  return new Promise<WorkerResult>((resolve) => {
    const startTime = Date.now();
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    const stallGracePeriodMs = options.stallGracePeriodMs ?? DEFAULT_STALL_GRACE_MS;
    const killGracePeriodMs = options.killGracePeriodMs ?? DEFAULT_KILL_GRACE_MS;
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

    const args = buildWorkerArgs(options);

    const worker = spawn(options.bin, args, {
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

    // Holds the pending SIGKILL escalation so a clean post-SIGTERM exit can cancel it
    // (close/error clear it). Otherwise it lingers up to killGracePeriodMs, holding the
    // event loop open and risking a stray group-kill against a reused PID.
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    if (options.signal) {
      const onAbort = (): void => {
        killed = true;
        killReason = "Aborted — ticket left the phase";
        killTimer = terminateWorker(worker, killGracePeriodMs);
      };
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
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
          killTimer = terminateWorker(worker, killGracePeriodMs);
        }
      }
      lastCpuTime = cpuTimeSecs;
    }, heartbeatIntervalMs);

    const timeoutTimer = setTimeout(() => {
      killed = true;
      killReason = `Worker timeout (${String(Math.round(options.timeoutMs / 1000))}s)`;
      killTimer = terminateWorker(worker, killGracePeriodMs);
    }, options.timeoutMs);

    worker.on("close", (code) => {
      clearInterval(heartbeat);
      clearTimeout(timeoutTimer);
      if (killTimer !== null) {
        clearTimeout(killTimer);
      }
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const exitCode = code ?? -1;

      const { summary, usage, reportedCostUsd } =
        (options.agent ?? "claude-code") === "codex"
          ? parseCodexOutput(stdout)
          : extractWorkerOutput(stdout);

      if (exitCode === 0 && killed === false) {
        resolve({ success: true, exitCode, elapsed, summary, error: null, usage, reportedCostUsd });
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
        summary,
        error,
        usage,
        reportedCostUsd,
      });
    });

    worker.on("error", (err: Error) => {
      clearInterval(heartbeat);
      clearTimeout(timeoutTimer);
      if (killTimer !== null) {
        clearTimeout(killTimer);
      }
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      resolve({
        success: false,
        exitCode: -1,
        elapsed,
        summary: "",
        error: err.message,
        usage: null,
        reportedCostUsd: null,
      });
    });
  });
}

function terminateWorker(
  worker: ReturnType<typeof spawn>,
  killGracePeriodMs: number,
): ReturnType<typeof setTimeout> {
  signalWorker(worker, "SIGTERM");
  return setTimeout(() => {
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

interface ExtractedOutput {
  summary: string;
  usage: RunUsage | null;
  reportedCostUsd: number | null;
}

export function extractWorkerOutput(stdout: string): ExtractedOutput {
  if (stdout.length === 0) {
    return { summary: "Completed (no output)", usage: null, reportedCostUsd: null };
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
      const summary =
        raw !== null ? truncate(raw, SUMMARY_MAX_LEN) : truncate(stdout, SUMMARY_MAX_LEN);
      return {
        summary,
        usage: extractUsage(obj),
        reportedCostUsd: numericField(obj, "total_cost_usd"),
      };
    }
  } catch {
    // Fall through to raw stdout handling
  }
  return { summary: truncate(stdout, SUMMARY_MAX_LEN), usage: null, reportedCostUsd: null };
}

// Codex `exec --json` emits JSONL events on stdout. The final message is the
// last `item.completed` whose item is an agent_message; token usage rides the
// last `turn.completed`. Unparseable lines (including the 10MB truncation
// marker) are skipped; a stream with no recognizable events degrades to raw
// stdout, mirroring the claude non-JSON fallback.
export function parseCodexOutput(stdout: string): ExtractedOutput {
  if (stdout.length === 0) {
    return { summary: "Completed (no output)", usage: null, reportedCostUsd: null };
  }
  let lastMessage: string | null = null;
  let usage: RunUsage | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed === null || typeof parsed !== "object") {
        continue;
      }
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "item.completed") {
      const item = event.item;
      if (item !== null && typeof item === "object") {
        const itemObj = item as Record<string, unknown>;
        if (itemObj.type === "agent_message" && typeof itemObj.text === "string") {
          lastMessage = itemObj.text;
        }
      }
    } else if (event.type === "turn.completed") {
      const raw = event.usage;
      if (raw !== null && typeof raw === "object") {
        const u = raw as Record<string, unknown>;
        const input = numericField(u, "input_tokens") ?? 0;
        const cached = numericField(u, "cached_input_tokens") ?? 0;
        usage = {
          // Codex's input_tokens includes cached reads; the Anthropic-shaped
          // RunUsage counts them separately.
          inputTokens: Math.max(0, input - cached),
          outputTokens: numericField(u, "output_tokens") ?? 0,
          cacheReadTokens: cached,
          cacheCreationTokens: 0,
        };
      }
    }
  }
  const summary =
    lastMessage !== null
      ? truncate(lastMessage, SUMMARY_MAX_LEN)
      : truncate(stdout, SUMMARY_MAX_LEN);
  return { summary, usage, reportedCostUsd: null };
}

function extractUsage(obj: Record<string, unknown>): RunUsage | null {
  // Claude Code's -p --output-format json emits usage on the top-level
  // result object. Field names match the Anthropic API (snake_case).
  const raw = obj.usage;
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return null;
  }
  const u = raw as Record<string, unknown>;
  const input = numericField(u, "input_tokens");
  const output = numericField(u, "output_tokens");
  const cacheRead = numericField(u, "cache_read_input_tokens");
  const cacheCreation = numericField(u, "cache_creation_input_tokens");
  if (input === null && output === null && cacheRead === null && cacheCreation === null) {
    return null;
  }
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: cacheRead ?? 0,
    cacheCreationTokens: cacheCreation ?? 0,
  };
}

function numericField(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.substring(0, max)}...`;
}
