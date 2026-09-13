import { describe, expect, it } from "vitest";
import { makeTestConfig } from "../../core/__tests__/fixtures/test-config.js";
import type { RepoConfig } from "../../core/config.js";
import { CliError } from "../errors.js";
import { resolveRepoArg } from "../repo-arg.js";

function repo(name: string): RepoConfig {
  return {
    name,
    path: `/srv/${name}`,
    owner: "acme",
    repo: name,
    baseBranch: "origin/main",
    buildCommand: "build",
    testCommand: "test",
    modules: [],
  };
}

describe("resolveRepoArg", () => {
  const workspace = makeTestConfig({ project: { repos: [repo("api"), repo("web")] } });
  const legacy = makeTestConfig();

  it("defaults to the sole repo in legacy mode", () => {
    expect(resolveRepoArg(legacy, undefined, "pr diff")).toBe(legacy.project.repos[0]);
  });

  it.each([[repo("api")], [repo("api"), repo("web")]])(
    "requires --repo in workspace mode with %j",
    (...repos) => {
      const config = makeTestConfig({ project: { repos } });
      expect(() => resolveRepoArg(config, undefined, "pr diff")).toThrow(
        /pr diff: --repo <name> is required.*api/,
      );
    },
  );

  it("resolves exact configured names in either mode", () => {
    expect(resolveRepoArg(workspace, "web", "pr diff")).toBe(workspace.project.repos[1]);
    expect(resolveRepoArg(legacy, "app", "pr diff")).toBe(legacy.project.repos[0]);
  });

  it.each(["missing", "WEB", ""])("rejects unknown name %j with valid names", (raw) => {
    expect(() => resolveRepoArg(workspace, raw, "pr diff")).toThrow(CliError);
    expect(() => resolveRepoArg(workspace, raw, "pr diff")).toThrow(
      `pr diff: unknown repo "${raw}" — valid: api, web`,
    );
  });
});
