import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type RedQueenConfig } from "../../core/config.js";
import { ensureClaudeBinConfigured, writeClaudeBinToConfig } from "../service.js";

function baseConfig(): RedQueenConfig {
  return parseConfig(
    [
      "issueTracker:",
      "  type: jira",
      "sourceControl:",
      "  type: github",
      "project:",
      "  buildCommand: npm run build",
      "  testCommand: npm test",
      "",
    ].join("\n"),
  );
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rq-svc-cli-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("writeClaudeBinToConfig", () => {
  it("sets pipeline.claudeBin in an existing config and preserves unrelated comments", () => {
    const configPath = join(tmp, "redqueen.yaml");
    const original = [
      "# top-level comment",
      "issueTracker:",
      "  type: jira",
      "sourceControl:",
      "  type: github",
      "project:",
      "  buildCommand: npm run build",
      "  testCommand: npm test",
      "pipeline:",
      "  # polling cadence in seconds",
      "  pollInterval: 30",
      "",
    ].join("\n");
    writeFileSync(configPath, original, "utf8");

    writeClaudeBinToConfig(configPath, "/Users/alice/.local/bin/claude");

    const rewritten = readFileSync(configPath, "utf8");
    expect(rewritten).toContain("claudeBin: /Users/alice/.local/bin/claude");
    expect(rewritten).toContain("# top-level comment");
    expect(rewritten).toContain("# polling cadence in seconds");
    expect(rewritten).toContain("pollInterval: 30");
  });

  it("creates the pipeline block when it's missing entirely", () => {
    const configPath = join(tmp, "redqueen.yaml");
    writeFileSync(configPath, ["issueTracker:", "  type: github-issues", ""].join("\n"), "utf8");

    writeClaudeBinToConfig(configPath, "/bin/claude");

    const rewritten = readFileSync(configPath, "utf8");
    expect(rewritten).toContain("pipeline:");
    expect(rewritten).toContain("claudeBin: /bin/claude");
  });
});

describe("ensureClaudeBinConfigured", () => {
  it("detects and writes when claudeBin is unset", async () => {
    const config = baseConfig();
    expect(config.pipeline.claudeBin).toBeUndefined();

    const detect = vi.fn<() => Promise<string | null>>(() => Promise.resolve("/tmp/claude"));
    const write = vi.fn<(p: string, v: string) => void>();

    const note = await ensureClaudeBinConfigured(config, "/tmp/redqueen.yaml", { detect, write });

    expect(note).toEqual({ kind: "auto-detected", path: "/tmp/claude" });
    expect(detect).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("/tmp/redqueen.yaml", "/tmp/claude");
    expect(config.pipeline.claudeBin).toBe("/tmp/claude");
  });

  it("never overwrites an explicit claudeBin value", async () => {
    const config = baseConfig();
    config.pipeline.claudeBin = "/user/chosen/claude";

    const detect = vi.fn<() => Promise<string | null>>();
    const write = vi.fn<(p: string, v: string) => void>();

    const note = await ensureClaudeBinConfigured(config, "/tmp/redqueen.yaml", { detect, write });

    expect(note).toEqual({ kind: "already-set" });
    expect(detect).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(config.pipeline.claudeBin).toBe("/user/chosen/claude");
  });

  it("returns unresolved without writing when `which` can't find claude", async () => {
    const config = baseConfig();

    const detect = vi.fn<() => Promise<string | null>>(() => Promise.resolve(null));
    const write = vi.fn<(p: string, v: string) => void>();

    const note = await ensureClaudeBinConfigured(config, "/tmp/redqueen.yaml", { detect, write });

    expect(note).toEqual({ kind: "unresolved" });
    expect(write).not.toHaveBeenCalled();
    expect(config.pipeline.claudeBin).toBeUndefined();
  });
});
