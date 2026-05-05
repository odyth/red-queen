import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { renderPlist } from "../macos.js";
import { renderUnit } from "../linux.js";
import {
  computeServiceName,
  extractStdout,
  renderWrapperScript,
  resolveServicePaths,
  ServicePathError,
  shellSingleQuote,
  writeWrapperScript,
} from "../index.js";
import { parseConfig } from "../../config.js";
import type { ServiceInstallContext } from "../manager.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(here, "fixtures");

const FIXTURE_CONTEXT: ServiceInstallContext = {
  name: "sh.redqueen.fixture1",
  workingDirectory: "/home/user/app",
  envFilePath: "/home/user/app/.env",
  stdoutLogPath: "/home/user/app/.redqueen/redqueen.out.log",
  stderrLogPath: "/home/user/app/.redqueen/redqueen.err.log",
  wrapperScriptPath: "/home/user/app/.redqueen/run-redqueen.sh",
  redqueenBinPath: "/usr/local/bin/redqueen",
  restart: "on-failure",
};

describe("computeServiceName", () => {
  it("defaults to sh.redqueen.<8-char hash> of the project dir", () => {
    const name = computeServiceName("/some/absolute/path");
    expect(name).toMatch(/^sh\.redqueen\.[0-9a-f]{8}$/);
  });

  it("is deterministic for a given path", () => {
    expect(computeServiceName("/a/b")).toBe(computeServiceName("/a/b"));
  });

  it("honours the override when provided", () => {
    expect(computeServiceName("/a/b", "custom.name")).toBe("custom.name");
  });
});

describe("shellSingleQuote", () => {
  it("wraps simple values in single quotes", () => {
    expect(shellSingleQuote("/home/user/.env")).toBe("'/home/user/.env'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellSingleQuote("it's fine")).toBe(`'it'\\''s fine'`);
  });

  it("preserves spaces and shell metacharacters unharmed", () => {
    expect(shellSingleQuote("/tmp/dir with $VAR && rm/")).toBe("'/tmp/dir with $VAR && rm/'");
  });
});

describe("renderWrapperScript", () => {
  it("produces a bash script that sources the env file and execs node redqueen start", () => {
    const script = renderWrapperScript({
      envFilePath: "/home/user/app/.env",
      redqueenBinPath: "/usr/local/bin/redqueen",
      nodeBinPath: "/usr/local/bin/node",
    });
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("set -e");
    expect(script).toContain(". '/home/user/app/.env'");
    expect(script).toContain("exec '/usr/local/bin/node' '/usr/local/bin/redqueen' start");
  });

  it("survives paths with spaces via single-quote escape", () => {
    const script = renderWrapperScript({
      envFilePath: "/home/user/my project/.env",
      redqueenBinPath: "/usr/local/bin/redqueen",
      nodeBinPath: "/usr/local/bin/node",
    });
    expect(script).toContain(". '/home/user/my project/.env'");
  });
});

describe("writeWrapperScript", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rq-wrap-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the script with mode 0o755 and expected contents", () => {
    const path = join(dir, "run.sh");
    writeWrapperScript(path, {
      envFilePath: join(dir, ".env"),
      redqueenBinPath: "/usr/local/bin/redqueen",
      nodeBinPath: "/usr/local/bin/node",
    });
    const stat = statSync(path);
    expect(stat.mode & 0o777).toBe(0o755);
    const content = readFileSync(path, "utf8");
    expect(content).toContain(`. '${join(dir, ".env")}'`);
  });
});

describe("renderPlist", () => {
  it("matches the committed golden fixture", () => {
    const plist = renderPlist(FIXTURE_CONTEXT);
    const expected = readFileSync(join(FIXTURE_DIR, "expected.plist"), "utf8");
    expect(plist).toBe(expected);
  });

  it("emits <true/> KeepAlive when restart=always", () => {
    const plist = renderPlist({ ...FIXTURE_CONTEXT, restart: "always" });
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  });

  it("omits KeepAlive entirely when restart=never", () => {
    const plist = renderPlist({ ...FIXTURE_CONTEXT, restart: "never" });
    expect(plist.includes("KeepAlive")).toBe(false);
  });

  it("never leaks secret env values into the plist", () => {
    const original = { ...process.env };
    process.env.JIRA_TOKEN = "supersecret1234";
    process.env.GITHUB_PAT = "pat1234567890";
    try {
      const plist = renderPlist(FIXTURE_CONTEXT);
      expect(plist.includes("supersecret1234")).toBe(false);
      expect(plist.includes("pat1234567890")).toBe(false);
    } finally {
      process.env = original;
    }
  });
});

describe("resolveServicePaths", () => {
  const baseYaml = `
issueTracker:
  type: jira
sourceControl:
  type: github
project:
  buildCommand: "npm run build"
  testCommand: "npm test"
`;

  it("returns absolute paths for a default config", () => {
    const config = parseConfig(baseYaml);
    const paths = resolveServicePaths(config, "/tmp/proj");
    expect(paths.envFilePath).toBe("/tmp/proj/.env");
    expect(paths.stdoutLogPath).toBe("/tmp/proj/.redqueen/redqueen.out.log");
    expect(paths.wrapperScriptPath).toBe("/tmp/proj/.redqueen/run-redqueen.sh");
    expect(paths.name).toMatch(/^sh\.redqueen\.[0-9a-f]{8}$/);
  });

  it("rejects paths with embedded newlines", () => {
    const config = parseConfig(`${baseYaml}service:
  envFile: "foo\\nUser=root"
`);
    expect(() => resolveServicePaths(config, "/tmp/proj")).toThrow(ServicePathError);
  });

  it("rejects paths with embedded carriage returns", () => {
    const config = parseConfig(`${baseYaml}service:
  stdoutLog: "logs\\rfoo"
`);
    expect(() => resolveServicePaths(config, "/tmp/proj")).toThrow(ServicePathError);
  });

  it("rejects paths with NUL bytes", () => {
    const config = parseConfig(`${baseYaml}service:
  stderrLog: "logs\\u0000evil"
`);
    expect(() => resolveServicePaths(config, "/tmp/proj")).toThrow(ServicePathError);
  });
});

describe("extractStdout", () => {
  it("returns the string stdout property", () => {
    expect(extractStdout({ stdout: "hello" })).toBe("hello");
  });

  it("decodes Buffer stdout", () => {
    expect(extractStdout({ stdout: Buffer.from("bytes", "utf8") })).toBe("bytes");
  });

  it("returns empty string for non-object errors or missing stdout", () => {
    expect(extractStdout(null)).toBe("");
    expect(extractStdout("oops")).toBe("");
    expect(extractStdout({})).toBe("");
    expect(extractStdout({ stdout: 42 })).toBe("");
  });
});

describe("renderUnit", () => {
  it("matches the committed golden fixture", () => {
    const unit = renderUnit(FIXTURE_CONTEXT);
    const expected = readFileSync(join(FIXTURE_DIR, "expected.service"), "utf8");
    expect(unit).toBe(expected);
  });

  it("maps restart=always to Restart=always", () => {
    const unit = renderUnit({ ...FIXTURE_CONTEXT, restart: "always" });
    expect(unit).toContain("Restart=always");
  });

  it("maps restart=never to Restart=no", () => {
    const unit = renderUnit({ ...FIXTURE_CONTEXT, restart: "never" });
    expect(unit).toContain("Restart=no");
  });

  it("references the env file via EnvironmentFile, never inline", () => {
    const original = { ...process.env };
    process.env.JIRA_TOKEN = "supersecret1234";
    process.env.GITHUB_PAT = "pat1234567890";
    try {
      const unit = renderUnit(FIXTURE_CONTEXT);
      expect(unit).toContain(`EnvironmentFile=${FIXTURE_CONTEXT.envFilePath}`);
      expect(unit.includes("supersecret1234")).toBe(false);
      expect(unit.includes("pat1234567890")).toBe(false);
    } finally {
      process.env = original;
    }
  });
});
