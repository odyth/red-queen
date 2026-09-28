import { describe, it, expect } from "vitest";
import { MockSourceControl } from "../../core/__tests__/fixtures/mock-adapters.js";
import { createSourceControlRegistry, repoFullName } from "../source-control-registry.js";

describe("createSourceControlRegistry", () => {
  const a = new MockSourceControl();
  const b = new MockSourceControl();
  const registry = createSourceControlRegistry([
    { name: "alignsmart", fullName: "AlignSmart/AlignSmart", adapter: a },
    { name: "app", fullName: "alignsmart/App", adapter: b },
  ]);

  it("resolves adapters by repo name", () => {
    expect(registry.get("app")).toBe(b);
    expect(registry.names()).toEqual(["alignsmart", "app"]);
    expect(registry.any()).toBe(a);
  });

  it("throws with the valid names on an unknown repo", () => {
    expect(() => registry.get("nope")).toThrow(/Unknown repo "nope".*alignsmart, app/);
  });

  it("resolves by full name case-insensitively", () => {
    expect(registry.byFullName("alignsmart/app")?.name).toBe("app");
    expect(registry.byFullName("ALIGNSMART/ALIGNSMART")?.adapter).toBe(a);
    expect(registry.byFullName("other/x")).toBeNull();
  });

  it("refuses an empty registry", () => {
    expect(() => createSourceControlRegistry([])).toThrow(/at least one/);
  });

  it("rejects duplicate names before they can shadow another adapter", () => {
    expect(() =>
      createSourceControlRegistry([
        { name: "app", fullName: "acme/app", adapter: a },
        { name: "app", fullName: "acme/web", adapter: b },
      ]),
    ).toThrow(/Duplicate repo name "app"/);
  });

  it("rejects duplicate full names case-insensitively", () => {
    expect(() =>
      createSourceControlRegistry([
        { name: "app", fullName: "acme/App", adapter: a },
        { name: "alias", fullName: "ACME/app", adapter: b },
      ]),
    ).toThrow(/Duplicate repo full name "ACME\/app"/);
  });

  it("repoFullName falls back to the repo name when owner or repo is empty", () => {
    expect(repoFullName({ name: "default", owner: "", repo: "" })).toBe("default");
    expect(repoFullName({ name: "app", owner: "acme", repo: "App" })).toBe("acme/App");
  });
});
