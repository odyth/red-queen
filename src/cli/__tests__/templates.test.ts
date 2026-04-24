import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { listTemplates, templatePath } from "../templates.js";

describe("template discovery", () => {
  it("lists the expected spec templates", () => {
    const options = listTemplates("spec-template");
    expect(options).toContain("generic");
  });

  it("lists the expected coding-standards templates", () => {
    const options = listTemplates("coding-standards");
    expect(options).toEqual(
      expect.arrayContaining([
        "node-ts",
        "python",
        "go",
        "rust",
        "ruby",
        "java",
        "dotnet",
        "blank",
      ]),
    );
  });

  it("lists the expected review-checklist templates", () => {
    const options = listTemplates("review-checklist");
    expect(options).toEqual(expect.arrayContaining(["web-api", "library-sdk", "blank"]));
  });

  it("resolves template paths to existing files", () => {
    const path = templatePath("coding-standards", "node-ts");
    expect(existsSync(path)).toBe(true);
  });
});
