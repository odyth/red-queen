import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findConfigUpward,
  loadConfigFromProject,
  projectRootFromConfigPath,
} from "../config-discovery.js";

let tmp: string;

describe("findConfigUpward", () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rq-cfg-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the config path when present in the start dir", () => {
    const path = join(tmp, "redqueen.yaml");
    writeFileSync(path, "issueTracker:\n  type: mock\n");
    expect(findConfigUpward(tmp)).toBe(path);
  });

  it("walks up from a nested directory", () => {
    const nested = join(tmp, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    const path = join(tmp, "redqueen.yaml");
    writeFileSync(path, "issueTracker:\n  type: mock\n");
    expect(findConfigUpward(nested)).toBe(path);
  });

  it("returns null when no config exists along the path", () => {
    const nested = join(tmp, "x", "y");
    mkdirSync(nested, { recursive: true });
    expect(findConfigUpward(nested)).toBeNull();
  });
});

describe("projectRootFromConfigPath", () => {
  it("returns the directory of the config file", () => {
    expect(projectRootFromConfigPath("/a/b/redqueen.yaml")).toBe("/a/b");
  });
});

describe("loadConfigFromProject", () => {
  let tmpProj: string;
  let originalEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    tmpProj = mkdtempSync(join(tmpdir(), "rq-lcfp-"));
    originalEnv = { ...process.env };
    delete process.env.JIRA_TOKEN_TEST;
  });
  afterEach(() => {
    rmSync(tmpProj, { recursive: true, force: true });
    process.env = originalEnv;
  });

  it("loads the adjacent .env into process.env before interpolating config", () => {
    writeFileSync(join(tmpProj, ".env"), "JIRA_TOKEN_TEST=from-dotenv\n");
    writeFileSync(
      join(tmpProj, "redqueen.yaml"),
      [
        "issueTracker:",
        "  type: jira",
        "  config:",
        "    token: ${JIRA_TOKEN_TEST}",
        "sourceControl:",
        "  type: github",
        "project:",
        "  buildCommand: npm run build",
        "  testCommand: npm test",
        "",
      ].join("\n"),
    );

    expect(process.env.JIRA_TOKEN_TEST).toBeUndefined();
    const loaded = loadConfigFromProject(tmpProj);
    expect(process.env.JIRA_TOKEN_TEST).toBe("from-dotenv");
    expect(loaded.config.issueTracker.config.token).toBe("from-dotenv");
    expect(loaded.configDir).toBe(tmpProj);
    expect(loaded.projectRoot).toBe(tmpProj);
  });

  it("throws a CliError when no redqueen.yaml is found along the path", () => {
    const nested = join(tmpProj, "x");
    mkdirSync(nested, { recursive: true });
    expect(() => loadConfigFromProject(nested)).toThrow(/redqueen\.yaml not found/);
  });
});
