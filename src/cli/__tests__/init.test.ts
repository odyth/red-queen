import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdInit } from "../init.js";
import { parseConfig } from "../../core/config.js";

let tmp: string;
let originalCwd: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rq-init-"));
  originalCwd = process.cwd();
  // Each init run needs a fresh git repo.
  execSync("git init -q", { cwd: tmp });
  execSync("git config user.email test@example.com", { cwd: tmp });
  execSync("git config user.name Test", { cwd: tmp });
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("cmdInit --yes", () => {
  it("scaffolds a working project from scratch", async () => {
    writeFileSync(
      join(tmp, "package.json"),
      '{"name":"demo","scripts":{"build":"tsc","test":"vitest"}}',
    );
    await cmdInit(["--yes"]);

    expect(existsSync(join(tmp, "redqueen.yaml"))).toBe(true);
    expect(existsSync(join(tmp, ".redqueen", "codebase-map.md"))).toBe(true);
    expect(existsSync(join(tmp, ".redqueen", "references", "coding-standards.md"))).toBe(true);
    expect(existsSync(join(tmp, ".redqueen", "references", "review-checklist.md"))).toBe(true);
    expect(existsSync(join(tmp, ".redqueen", "references", "spec-template.md"))).toBe(true);
    expect(existsSync(join(tmp, ".redqueen", "skills", ".gitkeep"))).toBe(true);

    const gitignore = readFileSync(join(tmp, ".gitignore"), "utf8");
    expect(gitignore).toContain(".redqueen/redqueen.db");
    expect(gitignore).toContain(".redqueen/worktrees/");

    const yaml = readFileSync(join(tmp, "redqueen.yaml"), "utf8");
    // Must load cleanly.
    const config = parseConfig(yaml);
    expect(config.project.buildCommand).toBe("npm run build");
    expect(config.project.testCommand).toBe("npm test");
    expect(config.pipeline.baseBranch).toMatch(/^origin\//);
  });

  it("refuses to run twice without --force", async () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    await cmdInit(["--yes"]);
    await expect(cmdInit(["--yes"])).rejects.toThrow(/already exists/);
  });

  it("--force overwrites the existing config", async () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    await cmdInit(["--yes"]);
    await expect(cmdInit(["--yes", "--force"])).resolves.toBeUndefined();
  });

  it("coding-standards file picks the language-specific template in --yes mode", async () => {
    writeFileSync(join(tmp, "Cargo.toml"), "[package]\nname='x'\n");
    await cmdInit(["--yes"]);
    const content = readFileSync(
      join(tmp, ".redqueen", "references", "coding-standards.md"),
      "utf8",
    );
    expect(content).toMatch(/Coding Standards — Rust/);
  });

  it("blank language falls back to blank coding-standards", async () => {
    await cmdInit(["--yes"]);
    const content = readFileSync(
      join(tmp, ".redqueen", "references", "coding-standards.md"),
      "utf8",
    );
    expect(content).toMatch(/Coding Standards \(TODO\)/);
  });
});

describe("cmdInit --map-only", () => {
  it("regenerates the codebase map while preserving Key Notes", async () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    await cmdInit(["--yes"]);

    const mapPath = join(tmp, ".redqueen", "codebase-map.md");
    const original = readFileSync(mapPath, "utf8");
    // Replace the Key Notes section with user-authored content.
    const withEdits = original.replace(
      /## Key Notes \(edit me\)[\s\S]*$/,
      "## Key Notes (edit me)\n- Custom note from human.\n",
    );
    writeFileSync(mapPath, withEdits);

    await cmdInit(["--map-only"]);

    const regenerated = readFileSync(mapPath, "utf8");
    expect(regenerated).toContain("- Custom note from human.");
    expect(regenerated).toContain("## Languages");
  });
});
