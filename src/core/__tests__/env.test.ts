import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv } from "../env.js";

describe("loadDotEnv", () => {
  let dir: string;
  const savedKeys: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rq-env-"));
    for (const key of [
      "RQ_TEST_KEY_A",
      "RQ_TEST_KEY_B",
      "RQ_TEST_QUOTED",
      "RQ_TEST_EXISTING",
      "RQ_TEST_INVALID",
    ]) {
      savedKeys[key] = process.env[key];
      Reflect.deleteProperty(process.env, key);
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedKeys)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  it("loads simple KEY=VALUE lines", () => {
    writeFileSync(join(dir, ".env"), "RQ_TEST_KEY_A=hello\nRQ_TEST_KEY_B=world\n");
    const result = loadDotEnv(dir);
    expect(result.path).toContain(".env");
    expect(result.loaded).toContain("RQ_TEST_KEY_A");
    expect(process.env.RQ_TEST_KEY_A).toBe("hello");
    expect(process.env.RQ_TEST_KEY_B).toBe("world");
  });

  it("ignores comments and blank lines", () => {
    writeFileSync(join(dir, ".env"), "\n# comment\n\nRQ_TEST_KEY_A=one\n");
    loadDotEnv(dir);
    expect(process.env.RQ_TEST_KEY_A).toBe("one");
  });

  it("strips surrounding quotes", () => {
    writeFileSync(join(dir, ".env"), 'RQ_TEST_QUOTED="with spaces"\n');
    loadDotEnv(dir);
    expect(process.env.RQ_TEST_QUOTED).toBe("with spaces");
  });

  it("does not override existing env vars", () => {
    process.env.RQ_TEST_EXISTING = "from-shell";
    writeFileSync(join(dir, ".env"), "RQ_TEST_EXISTING=from-file\n");
    const result = loadDotEnv(dir);
    expect(process.env.RQ_TEST_EXISTING).toBe("from-shell");
    expect(result.loaded).not.toContain("RQ_TEST_EXISTING");
  });

  it("warns on malformed lines", () => {
    writeFileSync(join(dir, ".env"), "NOT VALID\nRQ_TEST_KEY_A=ok\n");
    const result = loadDotEnv(dir);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(process.env.RQ_TEST_KEY_A).toBe("ok");
  });

  it("walks up to find .env", () => {
    const sub = join(dir, "a", "b");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, ".env"), "RQ_TEST_KEY_A=up\n");
    const result = loadDotEnv(sub);
    expect(process.env.RQ_TEST_KEY_A).toBe("up");
    expect(result.path).toContain(".env");
  });

  it("returns null path when no .env found", () => {
    const result = loadDotEnv(dir);
    expect(result.path).toBeNull();
    expect(result.loaded).toEqual([]);
  });
});
