import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLanguages, parseGitRemote, suggestCommands } from "../detect.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rq-det-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("detectLanguages", () => {
  it("detects Node.js via package.json", () => {
    writeFileSync(join(tmp, "package.json"), '{"name":"x"}');
    const result = detectLanguages(tmp);
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("node-ts");
  });

  it("detects Python via pyproject.toml", () => {
    writeFileSync(join(tmp, "pyproject.toml"), "[project]\nname='x'\n");
    const result = detectLanguages(tmp);
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("python");
  });

  it("detects Rust via Cargo.toml", () => {
    writeFileSync(join(tmp, "Cargo.toml"), "[package]\nname='x'\n");
    const result = detectLanguages(tmp);
    expect(result.map((d) => d.key)).toContain("rust");
  });

  it("detects .NET via .sln suffix", () => {
    writeFileSync(join(tmp, "MyApp.sln"), "");
    const result = detectLanguages(tmp);
    expect(result.map((d) => d.key)).toContain("dotnet");
  });

  it("returns empty array when nothing matches", () => {
    expect(detectLanguages(tmp)).toEqual([]);
  });

  it("detects multiple languages", () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    writeFileSync(join(tmp, "pyproject.toml"), "");
    const result = detectLanguages(tmp);
    expect(result.map((d) => d.key).sort()).toEqual(["node-ts", "python"]);
  });
});

describe("suggestCommands", () => {
  it("returns empty for node with no build/test scripts", () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    const cmds = suggestCommands("node-ts", tmp);
    expect(cmds.build).toBe("");
    expect(cmds.test).toBe("");
  });

  it("uses npm run build / npm test when scripts are defined", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }),
    );
    const cmds = suggestCommands("node-ts", tmp);
    expect(cmds.build).toBe("npm run build");
    expect(cmds.test).toBe("npm test");
  });

  it("falls back to defaults when package.json is missing", () => {
    const cmds = suggestCommands("node-ts", tmp);
    expect(cmds.build).toBe("npm run build");
    expect(cmds.test).toBe("npm test");
  });

  it("returns empty build for Python", () => {
    const cmds = suggestCommands("python", tmp);
    expect(cmds.build).toBe("");
    expect(cmds.test).toBe("pytest");
  });

  it("returns cargo commands for Rust", () => {
    const cmds = suggestCommands("rust", tmp);
    expect(cmds.build).toBe("cargo build");
    expect(cmds.test).toBe("cargo test");
  });

  it("returns gradle when build.gradle is present", () => {
    writeFileSync(join(tmp, "build.gradle"), "");
    const cmds = suggestCommands("java", tmp);
    expect(cmds.build).toMatch(/gradle/);
    expect(cmds.test).toMatch(/gradle/);
  });

  it("returns maven when no gradle file", () => {
    const cmds = suggestCommands("java", tmp);
    expect(cmds.build).toMatch(/mvn/);
    expect(cmds.test).toMatch(/mvn/);
  });
});

describe("parseGitRemote", () => {
  it("parses https URLs", () => {
    expect(parseGitRemote("https://github.com/acme/repo.git")).toEqual({
      owner: "acme",
      repo: "repo",
    });
  });

  it("parses ssh URLs", () => {
    expect(parseGitRemote("git@github.com:acme/repo.git")).toEqual({
      owner: "acme",
      repo: "repo",
    });
  });

  it("parses https URLs without .git suffix", () => {
    expect(parseGitRemote("https://github.com/acme/repo")).toEqual({
      owner: "acme",
      repo: "repo",
    });
  });

  it("returns null for unrecognized formats", () => {
    expect(parseGitRemote("not-a-url")).toBeNull();
  });
});
