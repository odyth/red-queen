import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildWorkerArgs,
  resolveAgentBin,
  resolveAgentSettings,
  resolveClaudeBin,
  runWorker,
} from "../worker.js";
import type { WorkerOptions } from "../worker.js";
import { parseConfig } from "../config.js";

let tempDir: string;

function writeScript(name: string, body: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("resolveClaudeBin", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-worker-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves config override when executable", () => {
    const bin = writeScript("claude", "#!/bin/sh\nexit 0\n");
    expect(resolveClaudeBin(bin)).toBe(bin);
  });

  it("returns null for non-executable override", () => {
    const path = join(tempDir, "nothere");
    expect(resolveClaudeBin(path)).toBeNull();
  });

  it("searches PATH when no override", () => {
    const fakeBin = writeScript("claude", "#!/bin/sh\nexit 0\n");
    const origPath = process.env.PATH;
    process.env.PATH = tempDir;
    try {
      expect(resolveClaudeBin()).toBe(fakeBin);
    } finally {
      process.env.PATH = origPath;
    }
  });
});

describe("resolveAgentBin", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-agent-bin-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves codexBin override for codex", () => {
    const bin = writeScript("codex", "#!/bin/sh\nexit 0\n");
    expect(resolveAgentBin("codex", { codexBin: bin })).toBe(bin);
  });

  it("resolves claudeBin override for claude-code", () => {
    const bin = writeScript("claude", "#!/bin/sh\nexit 0\n");
    expect(resolveAgentBin("claude-code", { claudeBin: bin })).toBe(bin);
  });

  it("walks PATH for the codex binary", () => {
    const fakeBin = writeScript("codex", "#!/bin/sh\nexit 0\n");
    const origPath = process.env.PATH;
    process.env.PATH = tempDir;
    try {
      expect(resolveAgentBin("codex", {})).toBe(fakeBin);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("returns null when codex is not installed", () => {
    const origPath = process.env.PATH;
    process.env.PATH = tempDir;
    try {
      expect(resolveAgentBin("codex", {})).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });
});

describe("resolveAgentSettings", () => {
  it("defaults to claude-code / opus / pipeline effort", () => {
    const settings = resolveAgentSettings({ agent: "claude-code", effort: "high" }, {});
    expect(settings).toEqual({ agent: "claude-code", model: "opus", effort: "high" });
  });

  it("phase overrides win over pipeline", () => {
    const settings = resolveAgentSettings(
      { agent: "claude-code", model: "sonnet", effort: "high" },
      { agent: "codex", model: "gpt-5.3-codex", effort: "xhigh" },
    );
    expect(settings).toEqual({ agent: "codex", model: "gpt-5.3-codex", effort: "xhigh" });
  });

  it("does not leak the pipeline model across an agent override", () => {
    const settings = resolveAgentSettings(
      { agent: "claude-code", model: "opus", effort: "high" },
      { agent: "codex" },
    );
    expect(settings.model).toBeNull();
  });

  it("inherits the pipeline model when the agent matches", () => {
    const settings = resolveAgentSettings(
      { agent: "codex", model: "gpt-5.3-codex", effort: "medium" },
      { effort: "high" },
    );
    expect(settings).toEqual({ agent: "codex", model: "gpt-5.3-codex", effort: "high" });
  });

  it("falls back to opus when a phase switches back to claude-code", () => {
    const settings = resolveAgentSettings(
      { agent: "codex", model: "gpt-5.3-codex", effort: "high" },
      { agent: "claude-code" },
    );
    expect(settings).toEqual({ agent: "claude-code", model: "opus", effort: "high" });
  });

  it("codex master without a model resolves to null", () => {
    const settings = resolveAgentSettings({ agent: "codex", effort: "high" }, {});
    expect(settings.model).toBeNull();
  });
});

describe("buildWorkerArgs", () => {
  const base: WorkerOptions = {
    bin: "/usr/bin/true",
    prompt: "Read and follow /tmp/x.md exactly.",
    cwd: "/tmp",
    timeoutMs: 1000,
    stallThresholdMs: 1000,
    model: "opus",
    effort: "high",
  };

  it("composes minimal config defaults into supported Claude worker arguments", () => {
    const config = parseConfig(`
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
`);
    const settings = resolveAgentSettings(config.pipeline, {});
    const args = buildWorkerArgs({
      ...base,
      agent: settings.agent,
      model: settings.model,
      effort: settings.effort,
    });

    expect(settings).toEqual({ agent: "claude-code", model: "opus", effort: "max" });
    expect(args[args.indexOf("--effort") + 1]).toBe("max");
  });

  it("builds the claude-code argv exactly as before", () => {
    expect(buildWorkerArgs(base)).toEqual([
      "-p",
      "Read and follow /tmp/x.md exactly.",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--model",
      "opus",
      "--effort",
      "high",
    ]);
  });

  it("builds the codex argv with a model", () => {
    expect(buildWorkerArgs({ ...base, agent: "codex", model: "gpt-5.3-codex" })).toEqual([
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      "danger-full-access",
      "-c",
      "model_reasoning_effort=high",
      "-m",
      "gpt-5.3-codex",
      "Read and follow /tmp/x.md exactly.",
    ]);
  });

  it("omits the model flag when model is null", () => {
    const codexArgs = buildWorkerArgs({ ...base, agent: "codex", model: null });
    expect(codexArgs).not.toContain("-m");
    const claudeArgs = buildWorkerArgs({ ...base, model: null });
    expect(claudeArgs).not.toContain("--model");
  });

  it.each(["max", "ultra", "future-mode"])("passes %s through unchanged for codex", (effort) => {
    const args = buildWorkerArgs({ ...base, agent: "codex", effort });
    expect(args).toContain(`model_reasoning_effort=${effort}`);
  });

  it("maps Claude's legacy minimal effort to low", () => {
    const args = buildWorkerArgs({ ...base, effort: "minimal" });
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
  });

  it("passes minimal through unchanged for codex", () => {
    const args = buildWorkerArgs({ ...base, agent: "codex", effort: "minimal" });
    expect(args).toContain("model_reasoning_effort=minimal");
  });

  it("passes effort through unchanged for claude-code", () => {
    const args = buildWorkerArgs({ ...base, effort: "future-mode" });
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("future-mode");
  });
});

describe("runWorker", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-worker-run-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(["claude-code", "codex"] as const)(
    "normalizes synchronous %s spawn argument failures",
    async (agent) => {
      const result = await runWorker({
        bin: "/usr/bin/true",
        agent,
        prompt: "",
        cwd: tempDir,
        timeoutMs: 5000,
        stallThresholdMs: 60000,
        model: null,
        effort: "\0",
      });

      expect(result).toMatchObject({
        success: false,
        exitCode: -1,
        summary: "",
        usage: null,
        reportedCostUsd: null,
      });
      expect(result.error).toContain("without null bytes");
    },
  );

  it("captures stdout JSON on success", async () => {
    // Script that prints a JSON result and exits 0. It ignores its args.
    const script = writeScript(
      "worker.sh",
      `#!/bin/sh
printf '%s' '{"result":"Completed the task"}'
exit 0
`,
    );
    const result = await runWorker({
      bin: script,
      prompt: "",
      cwd: tempDir,
      timeoutMs: 5000,
      stallThresholdMs: 60000,
      model: "opus",
      effort: "high",
      heartbeatIntervalMs: 1000,
      stallGracePeriodMs: 60000,
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Completed the task");
    expect(result.warning).toBeUndefined();
  });

  it("captures stderr as a warning on a successful exit", async () => {
    const script = writeScript(
      "worker.sh",
      `#!/bin/sh
echo "unsupported effort; using default" 1>&2
printf '%s' '{"result":"Completed the task"}'
exit 0
`,
    );
    const result = await runWorker({
      bin: script,
      prompt: "",
      cwd: tempDir,
      timeoutMs: 5000,
      stallThresholdMs: 60000,
      model: "opus",
      effort: "max",
      heartbeatIntervalMs: 1000,
      stallGracePeriodMs: 60000,
    });
    expect(result.success).toBe(true);
    expect(result.warning).toBe("unsupported effort; using default");
  });

  it("omits arbitrary successful stderr instead of persisting its contents", async () => {
    const script = writeScript(
      "worker.sh",
      `#!/bin/sh
echo "plugin request token=short-secret" 1>&2
printf '%s' '{"result":"Completed the task"}'
exit 0
`,
    );
    const result = await runWorker({
      bin: script,
      prompt: "",
      cwd: tempDir,
      timeoutMs: 5000,
      stallThresholdMs: 60000,
      model: "opus",
      effort: "max",
      heartbeatIntervalMs: 1000,
      stallGracePeriodMs: 60000,
    });

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("captures stderr on non-zero exit", async () => {
    const script = writeScript(
      "worker.sh",
      `#!/bin/sh
echo "bad things happened token=failure-secret" 1>&2
exit 2
`,
    );
    const result = await runWorker({
      bin: script,
      prompt: "",
      cwd: tempDir,
      timeoutMs: 5000,
      stallThresholdMs: 60000,
      model: "opus",
      effort: "high",
      heartbeatIntervalMs: 1000,
      stallGracePeriodMs: 60000,
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.error).toContain("bad things happened");
    expect(result.error).toContain("token=<redacted>");
    expect(result.error).not.toContain("failure-secret");
  });

  it("kills on hard timeout", async () => {
    const script = writeScript(
      "worker.sh",
      `#!/bin/sh
exec sleep 30
`,
    );
    const result = await runWorker({
      bin: script,
      prompt: "",
      cwd: tempDir,
      timeoutMs: 500,
      stallThresholdMs: 120000,
      model: "opus",
      effort: "high",
      heartbeatIntervalMs: 5000,
      stallGracePeriodMs: 60000,
      killGracePeriodMs: 100,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
  }, 10000);

  it("kills on stall detection", async () => {
    const script = writeScript(
      "worker.sh",
      `#!/bin/sh
exec sleep 60
`,
    );
    const result = await runWorker({
      bin: script,
      prompt: "",
      cwd: tempDir,
      timeoutMs: 30000,
      stallThresholdMs: 500,
      model: "opus",
      effort: "high",
      heartbeatIntervalMs: 250,
      stallGracePeriodMs: 0,
      killGracePeriodMs: 100,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("stalled");
  }, 10000);

  it("calls onStart and onHeartbeat", async () => {
    const script = writeScript(
      "worker.sh",
      `#!/bin/sh
sleep 0.3
echo '{"result":"ok"}'
`,
    );
    let startedPid: number | null = null;
    let heartbeatCount = 0;
    const result = await runWorker({
      bin: script,
      prompt: "",
      cwd: tempDir,
      timeoutMs: 5000,
      stallThresholdMs: 60000,
      model: "opus",
      effort: "high",
      heartbeatIntervalMs: 100,
      stallGracePeriodMs: 60000,
      onStart: (pid) => {
        startedPid = pid;
      },
      onHeartbeat: () => {
        heartbeatCount++;
      },
    });
    expect(result.success).toBe(true);
    expect(startedPid).not.toBeNull();
    expect(heartbeatCount).toBeGreaterThanOrEqual(1);
  });

  it("terminates the worker when the abort signal fires mid-run", async () => {
    const script = writeScript(
      "worker.sh",
      `#!/bin/sh
exec sleep 30
`,
    );
    const controller = new AbortController();
    const resultPromise = runWorker({
      bin: script,
      prompt: "",
      cwd: tempDir,
      timeoutMs: 30000,
      stallThresholdMs: 120000,
      model: "opus",
      effort: "high",
      heartbeatIntervalMs: 5000,
      stallGracePeriodMs: 60000,
      killGracePeriodMs: 100,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 100);
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Aborted");
  }, 10000);

  it("terminates immediately when the signal is already aborted", async () => {
    const script = writeScript(
      "worker.sh",
      `#!/bin/sh
exec sleep 30
`,
    );
    const controller = new AbortController();
    controller.abort();
    const result = await runWorker({
      bin: script,
      prompt: "",
      cwd: tempDir,
      timeoutMs: 30000,
      stallThresholdMs: 120000,
      model: "opus",
      effort: "high",
      heartbeatIntervalMs: 5000,
      stallGracePeriodMs: 60000,
      killGracePeriodMs: 100,
      signal: controller.signal,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Aborted");
  }, 10000);

  it("treats non-JSON stdout as raw summary", async () => {
    const script = writeScript(
      "worker.sh",
      `#!/bin/sh
printf '%s' 'plain text output'
exit 0
`,
    );
    const result = await runWorker({
      bin: script,
      prompt: "",
      cwd: tempDir,
      timeoutMs: 5000,
      stallThresholdMs: 60000,
      model: "opus",
      effort: "high",
      heartbeatIntervalMs: 1000,
      stallGracePeriodMs: 60000,
    });
    expect(result.success).toBe(true);
    expect(result.summary).toBe("plain text output");
  });

  it("parses codex JSONL output end-to-end", async () => {
    const script = writeScript(
      "codex.sh",
      `#!/bin/sh
printf '%s\\n' '{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"thinking"}}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Implemented the fix"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":200,"output_tokens":345}}'
exit 0
`,
    );
    const result = await runWorker({
      bin: script,
      agent: "codex",
      prompt: "",
      cwd: tempDir,
      timeoutMs: 5000,
      stallThresholdMs: 60000,
      model: null,
      effort: "high",
      heartbeatIntervalMs: 1000,
      stallGracePeriodMs: 60000,
    });
    expect(result.success).toBe(true);
    expect(result.summary).toBe("Implemented the fix");
    expect(result.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 345,
      cacheReadTokens: 200,
      cacheCreationTokens: 0,
    });
    expect(result.reportedCostUsd).toBeNull();
  });
});
