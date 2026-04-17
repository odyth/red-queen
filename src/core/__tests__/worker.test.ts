import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveClaudeBin, runWorker } from "../worker.js";

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

describe("runWorker", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-worker-run-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

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
      claudeBin: script,
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
  });

  it("captures stderr on non-zero exit", async () => {
    const script = writeScript(
      "worker.sh",
      `#!/bin/sh
echo "bad things happened" 1>&2
exit 2
`,
    );
    const result = await runWorker({
      claudeBin: script,
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
  });

  it("kills on hard timeout", async () => {
    const script = writeScript(
      "worker.sh",
      `#!/bin/sh
exec sleep 30
`,
    );
    const result = await runWorker({
      claudeBin: script,
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
      claudeBin: script,
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
      claudeBin: script,
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

  it("treats non-JSON stdout as raw summary", async () => {
    const script = writeScript(
      "worker.sh",
      `#!/bin/sh
printf '%s' 'plain text output'
exit 0
`,
    );
    const result = await runWorker({
      claudeBin: script,
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
});
