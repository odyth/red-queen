import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConfigUpward, projectRootFromConfigPath } from "../config-discovery.js";

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
