import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapterPair } from "../adapters.js";
import { GitHubSourceControlAdapter } from "../../integrations/github/adapter.js";
import { GitHubIssuesAdapter } from "../../integrations/github-issues/adapter.js";
import { PatAuthStrategy } from "../../integrations/github/auth/pat-strategy.js";
import type { RepoConfig } from "../../core/config.js";

function repo(name: string, owner: string, repoName: string): RepoConfig {
  return {
    name,
    path: `/srv/${name}`,
    owner,
    repo: repoName,
    baseBranch: "origin/main",
    buildCommand: "b",
    testCommand: "t",
    modules: [],
  };
}

describe("buildAdapterPair", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shares one auth strategy and warms every GitHub adapter", async () => {
    const identity = vi.spyOn(PatAuthStrategy.prototype, "getIdentity").mockResolvedValue({
      login: "bot",
      accountId: "1",
      isBot: true,
    });
    const warmSourceControl = vi.spyOn(GitHubSourceControlAdapter.prototype, "warmIdentity");
    const warmTracker = vi.spyOn(GitHubIssuesAdapter.prototype, "warmIdentity");
    const pair = buildAdapterPair({
      issueTrackerType: "github-issues",
      issueTrackerConfig: {
        owner: "planning",
        repo: "Planning",
        auth: { type: "pat", token: "x" },
      },
      sourceControlType: "github",
      sourceControlConfig: {},
      repos: [repo("app", "acme", "App"), repo("web", "other", "Web")],
      workspaceMode: true,
    });
    const app = pair.sourceControls.get("app") as GitHubSourceControlAdapter;
    const web = pair.sourceControls.get("web") as GitHubSourceControlAdapter;
    const tracker = pair.issueTracker as GitHubIssuesAdapter;
    expect(app.auth).toBe(web.auth);
    expect(app.auth).toBe(tracker.auth);
    await pair.warmup();
    expect(warmSourceControl).toHaveBeenCalledTimes(2);
    expect(warmTracker).toHaveBeenCalledTimes(1);
    expect(identity).toHaveBeenCalled();
  });

  it.each([
    { owners: ["acme", "other"], trackerOwner: "acme", inherited: true },
    { owners: ["acme", "acme"], trackerOwner: "other", inherited: true },
    { owners: ["acme", "acme"], trackerOwner: "other", inherited: false },
  ])(
    "rejects incompatible owners with effective App auth: %j",
    ({ owners, trackerOwner, inherited }) => {
      const auth = {
        type: "byo-app",
        appId: "1",
        installationId: "2",
        privateKeyPath: "missing.pem",
      };
      expect(() =>
        buildAdapterPair({
          issueTrackerType: "github-issues",
          issueTrackerConfig: {
            owner: trackerOwner,
            repo: "Planning",
            ...(inherited ? { auth } : {}),
          },
          sourceControlType: "github",
          sourceControlConfig: inherited ? {} : { auth },
          repos: owners.map((owner, index) => repo(`r${String(index)}`, owner, "App")),
          workspaceMode: true,
        }),
      ).toThrow(/byo-app.*same owner.*acme.*other|byo-app.*same owner.*other.*acme/);
    },
  );

  it("allows case variations of the same App owner and a separate planning repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "rq-app-auth-"));
    writeFileSync(join(dir, "key.pem"), "-----BEGIN PRIVATE KEY-----\nfixture\n");
    try {
      const pair = buildAdapterPair(
        {
          issueTrackerType: "github-issues",
          issueTrackerConfig: {
            owner: "ACME",
            repo: "Planning",
            auth: { type: "byo-app", appId: "1", installationId: "2", privateKeyPath: "key.pem" },
          },
          sourceControlType: "github",
          sourceControlConfig: {},
          repos: [repo("app", "acme", "App"), repo("web", "Acme", "Web")],
          workspaceMode: true,
        },
        { configDir: dir },
      );
      expect(pair.sourceControls.names()).toEqual(["app", "web"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects divergent paired auth", () => {
    expect(() =>
      buildAdapterPair({
        issueTrackerType: "github-issues",
        issueTrackerConfig: { owner: "acme", repo: "Planning", auth: { type: "pat", token: "x" } },
        sourceControlType: "github",
        sourceControlConfig: { auth: { type: "pat", token: "y" } },
        repos: [repo("app", "acme", "App")],
        workspaceMode: true,
      }),
    ).toThrow(/divergent auth/);
  });

  it("builds one mock adapter per repo", () => {
    const pair = buildAdapterPair({
      issueTrackerType: "mock",
      issueTrackerConfig: {},
      sourceControlType: "mock",
      sourceControlConfig: {},
      repos: [repo("a", "o", "A"), repo("b", "o", "B")],
      workspaceMode: true,
    });
    expect(pair.sourceControls.names()).toEqual(["a", "b"]);
    expect(pair.sourceControls.get("a")).not.toBe(pair.sourceControls.get("b"));
    expect(pair.sourceControls.byFullName("o/B")?.name).toBe("b");
  });

  it("github/github workspace mode shares auth without an owner/repo equality check", () => {
    const pair = buildAdapterPair({
      issueTrackerType: "github-issues",
      issueTrackerConfig: { owner: "acme", repo: "Planning", auth: { type: "pat", token: "x" } },
      sourceControlType: "github",
      sourceControlConfig: { auth: { type: "pat", token: "x" } },
      repos: [repo("app", "acme", "App"), repo("web", "acme", "Web")],
      workspaceMode: true,
    });
    expect(pair.sourceControls.names()).toEqual(["app", "web"]);
    expect(pair.sourceControls.get("web")).toBeInstanceOf(GitHubSourceControlAdapter);
  });

  it("github/github legacy mode still requires the same owner/repo", () => {
    expect(() =>
      buildAdapterPair({
        issueTrackerType: "github-issues",
        issueTrackerConfig: { owner: "acme", repo: "Other", auth: { type: "pat", token: "x" } },
        sourceControlType: "github",
        sourceControlConfig: { owner: "acme", repo: "App", auth: { type: "pat", token: "x" } },
        repos: [repo("app", "acme", "App")],
        workspaceMode: false,
      }),
    ).toThrow(/same owner\/repo/);
  });
});
