import { describe, expect, it } from "vitest";
import { gitCwdFor, repoConfigOf, worktreePathFor } from "../worktree-layout.js";
import { makeTestConfig } from "./fixtures/test-config.js";

const workspace = makeTestConfig({
  project: {
    directory: "/srv/ws",
    repos: ["api", "web"].map((name) => ({
      name,
      path: `/srv/ws/${name}`,
      owner: "acme",
      repo: name,
      baseBranch: "origin/main",
      buildCommand: "build",
      testCommand: "test",
      modules: [],
    })),
  },
});

describe("worktree layout", () => {
  it("nests each workspace repo in coding, spec and refresh worktrees", () => {
    expect(worktreePathFor(workspace, "PROJ-1", "api")).toBe(
      "/srv/ws/.redqueen/worktrees/PROJ-1/api",
    );
    expect(worktreePathFor(workspace, "PROJ-1", "web", "spec")).toBe(
      "/srv/ws/.redqueen/worktrees/spec-PROJ-1/web",
    );
    expect(worktreePathFor(workspace, "PROJ-1", "api", "refresh")).toBe(
      "/srv/ws/.redqueen/worktrees/refresh-PROJ-1/api",
    );
  });

  it("preserves flat legacy paths and legacy git cwd", () => {
    const legacy = makeTestConfig({ project: { directory: "/srv/app" } });
    expect(worktreePathFor(legacy, "PROJ-1", "app")).toBe("/srv/app/.redqueen/worktrees/PROJ-1");
    expect(worktreePathFor(legacy, "PROJ-1", "app", "spec")).toBe(
      "/srv/app/.redqueen/worktrees/spec-PROJ-1",
    );
    expect(worktreePathFor(legacy, "PROJ-1", "app", "refresh")).toBe(
      "/srv/app/.redqueen/worktrees/refresh-PROJ-1",
    );
    expect(gitCwdFor(legacy, "app")).toBe("/srv/app");
  });

  it("uses the selected repo path even for a one-repo workspace", () => {
    const config = makeTestConfig({
      project: { directory: "/srv/ws", repos: workspace.project.repos.slice(1) },
    });
    expect(repoConfigOf(config, "web").name).toBe("web");
    expect(gitCwdFor(config, "web")).toBe("/srv/ws/web");
    expect(worktreePathFor(config, "PROJ-1", "web")).toBe("/srv/ws/.redqueen/worktrees/PROJ-1/web");
  });

  it("rejects unknown repos in path and cwd helpers", () => {
    expect(() => repoConfigOf(workspace, "missing")).toThrow(/Unknown repo "missing".*api, web/);
    expect(() => gitCwdFor(workspace, "missing")).toThrow(/Unknown repo "missing".*api, web/);
    expect(() => worktreePathFor(workspace, "PROJ-1", "missing")).toThrow(
      /Unknown repo "missing".*api, web/,
    );
  });
});
