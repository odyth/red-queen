import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCodebaseMap, mergeRegeneratedMap } from "../codebase-map.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rq-map-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function sampleInput(overrides: Partial<Parameters<typeof generateCodebaseMap>[0]> = {}) {
  return {
    projectDir: tmp,
    languages: [{ key: "node-ts" as const, displayName: "Node.js", markerFile: "package.json" }],
    primary: "node-ts" as const,
    buildCommand: "npm run build",
    testCommand: "npm test",
    generatedAt: "2026-04-23",
    ...overrides,
  };
}

describe("generateCodebaseMap", () => {
  it("includes all required sections", () => {
    writeFileSync(join(tmp, "package.json"), '{"main":"dist/index.js"}');
    mkdirSync(join(tmp, "src"));
    const map = generateCodebaseMap(sampleInput());
    expect(map).toContain("# Codebase Map");
    expect(map).toContain("## Languages");
    expect(map).toContain("## Commands");
    expect(map).toContain("## Top-Level Layout");
    expect(map).toContain("## Entry Points");
    expect(map).toContain("## Key Notes (edit me)");
    expect(map).toContain("npm run build");
    expect(map).toContain("npm test");
  });

  it("excludes noise directories from layout", () => {
    mkdirSync(join(tmp, "node_modules"));
    mkdirSync(join(tmp, "src"));
    const map = generateCodebaseMap(sampleInput());
    expect(map).toContain("`src/`");
    expect(map).not.toContain("node_modules");
  });

  it("produces a reasonable map for an empty project", () => {
    const map = generateCodebaseMap(
      sampleInput({ languages: [], primary: "blank", buildCommand: "", testCommand: "" }),
    );
    expect(map).toContain("(no language markers");
    expect(map).toContain("(not configured)");
  });
});

describe("mergeRegeneratedMap", () => {
  it("preserves Key Notes section from the existing map", () => {
    const existing = [
      "# Codebase Map",
      "",
      "## Languages",
      "- Python (pyproject.toml detected)",
      "",
      "## Key Notes (edit me)",
      "- This project uses async patterns throughout.",
      "- See ARCHITECTURE.md for module details.",
      "",
    ].join("\n");
    const regenerated = [
      "# Codebase Map",
      "",
      "## Languages",
      "- Node.js (package.json detected)",
      "",
      "## Key Notes (edit me)",
      "- Default placeholder.",
      "",
    ].join("\n");

    const merged = mergeRegeneratedMap(existing, regenerated);
    expect(merged).toContain("- Node.js (package.json detected)");
    expect(merged).toContain("- This project uses async patterns throughout.");
    expect(merged).not.toContain("Default placeholder.");
  });

  it("throws when the marker is missing", () => {
    const existing = "# Codebase Map\n\n(user deleted the marker)\n";
    const regenerated = "# Codebase Map\n\n## Key Notes (edit me)\n- x\n";
    expect(() => mergeRegeneratedMap(existing, regenerated)).toThrow(/marker not found/);
  });
});
