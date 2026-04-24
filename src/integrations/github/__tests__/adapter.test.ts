import { describe, it, expect, beforeEach } from "vitest";
import type { GitHubAuthStrategy, GitHubIdentity } from "../auth.js";
import { GitHubSourceControlAdapter } from "../adapter.js";
import { GitHubClient } from "../client.js";

interface Call {
  label: string;
  args: Record<string, unknown>;
}

interface FakeOctokitBuilder {
  add(path: string, responder: (args: Record<string, unknown>) => unknown): void;
  octokit: unknown;
  calls: Call[];
  setPaginate(fn: (path: string, args: Record<string, unknown>) => unknown[]): void;
}

function buildFakeOctokit(): FakeOctokitBuilder {
  const routes = new Map<string, (args: Record<string, unknown>) => unknown>();
  const calls: Call[] = [];
  let paginate: (path: string, args: Record<string, unknown>) => unknown[] = () => [];

  const makeCall = (path: string): ((args: Record<string, unknown>) => Promise<unknown>) => {
    const fn = function paginated(args: Record<string, unknown>): Promise<unknown> {
      calls.push({ label: path, args });
      const responder = routes.get(path);
      if (responder === undefined) {
        return Promise.reject(Object.assign(new Error(`not found: ${path}`), { status: 404 }));
      }
      const value = responder(args);
      if (value instanceof Error) {
        return Promise.reject(value);
      }
      return Promise.resolve({ data: value });
    };
    (fn as unknown as { endpoint: unknown }).endpoint = { DEFAULTS: { url: path } };
    return fn;
  };

  const routeProxyHandler = {
    get(_target: unknown, prop: string): (args: Record<string, unknown>) => Promise<unknown> {
      return makeCall(prop);
    },
  };

  const repos = new Proxy({}, routeProxyHandler);
  const pulls = new Proxy({}, routeProxyHandler);
  const git = new Proxy({}, routeProxyHandler);
  const checks = new Proxy({}, routeProxyHandler);
  const issues = new Proxy({}, routeProxyHandler);

  const octokit = {
    rest: { repos, pulls, git, checks, issues },
    paginate: (method: unknown, args: Record<string, unknown>): Promise<unknown[]> => {
      const path = extractLabel(method);
      return Promise.resolve(paginate(path, args));
    },
    request: (path: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push({ label: path, args });
      const key = path.split(" ")[1] ?? path;
      const responder = routes.get(`request:${key}`) ?? routes.get("request");
      if (responder === undefined) {
        return Promise.reject(
          Object.assign(new Error(`request not mocked: ${path}`), { status: 404 }),
        );
      }
      return Promise.resolve({ data: responder(args) });
    },
  };

  function extractLabel(method: unknown): string {
    if (typeof method === "function") {
      return (method as { name?: string }).name ?? "";
    }
    return "";
  }

  return {
    add(path, responder) {
      routes.set(path, responder);
    },
    setPaginate(fn) {
      paginate = fn;
    },
    get octokit() {
      return octokit;
    },
    calls,
  };
}

class StubAuth implements GitHubAuthStrategy {
  token = "abc";
  identity: GitHubIdentity = { login: "bot", accountId: "1", isBot: true };
  getToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
  getIdentity(): Promise<GitHubIdentity> {
    return Promise.resolve(this.identity);
  }
}

describe("GitHubSourceControlAdapter", () => {
  let fake: ReturnType<typeof buildFakeOctokit>;
  let adapter: GitHubSourceControlAdapter;

  beforeEach(() => {
    fake = buildFakeOctokit();
    const client = new GitHubClient({
      auth: new StubAuth(),
      octokit: fake.octokit as GitHubClient["octokit"],
      sleep: () => Promise.resolve(),
    });
    adapter = new GitHubSourceControlAdapter({
      client,
      owner: "me",
      repo: "r",
      webhookSecret: null,
    });
  });

  it("creates a branch from base ref SHA", async () => {
    fake.add("getBranch", () => ({ commit: { sha: "abc123" } }));
    fake.add("createRef", () => ({}));
    await adapter.createBranch("feature/x", "main");
    const createCall = fake.calls.find((c) => c.label === "createRef");
    expect(createCall?.args.ref).toBe("refs/heads/feature/x");
    expect(createCall?.args.sha).toBe("abc123");
  });

  it("strips origin/ prefix when resolving base SHA", async () => {
    fake.add("getBranch", (args) => {
      expect(args.branch).toBe("main");
      return { commit: { sha: "abc123" } };
    });
    fake.add("createRef", () => ({}));
    await adapter.createBranch("feature/x", "origin/main");
  });

  it("returns branchExists=false on 404", async () => {
    const result = await adapter.branchExists("nope");
    expect(result).toBe(false);
  });

  it("returns branchExists=true on 200", async () => {
    fake.add("getBranch", () => ({ commit: { sha: "abc" } }));
    expect(await adapter.branchExists("main")).toBe(true);
  });

  it("creates a pull request", async () => {
    fake.add("create", () => ({
      number: 17,
      title: "t",
      state: "open",
      head: { ref: "feature/x" },
      base: { ref: "main" },
      html_url: "https://gh/pr/17",
    }));
    const pr = await adapter.createPullRequest({
      title: "t",
      body: "b",
      head: "feature/x",
      base: "main",
      draft: false,
    });
    expect(pr.number).toBe(17);
    expect(pr.url).toBe("https://gh/pr/17");
  });

  it("merges a PR using squash", async () => {
    fake.add("merge", (args) => {
      expect(args.merge_method).toBe("squash");
      return { sha: "z" };
    });
    await adapter.mergePullRequest(5);
  });

  it("posts approval review", async () => {
    fake.add("createReview", (args) => {
      expect(args.event).toBe("APPROVE");
      return {};
    });
    await adapter.postReview(5, "lgtm", "approve");
  });

  it("posts request-changes review", async () => {
    fake.add("createReview", (args) => {
      expect(args.event).toBe("REQUEST_CHANGES");
      return {};
    });
    await adapter.postReview(5, "fix", "request-changes");
  });

  it("dismisses only bot reviews with CHANGES_REQUESTED", async () => {
    fake.setPaginate(() => [
      { id: 1, state: "CHANGES_REQUESTED", user: { login: "bot", id: 1 } },
      { id: 2, state: "CHANGES_REQUESTED", user: { login: "alice", id: 2 } },
      { id: 3, state: "APPROVED", user: { login: "bot", id: 1 } },
    ]);
    const dismissed: number[] = [];
    fake.add("dismissReview", (args) => {
      dismissed.push(args.review_id as number);
      return {};
    });
    await adapter.dismissStaleReviews(5);
    expect(dismissed).toEqual([1]);
  });

  it("swallows 422 on dismiss", async () => {
    fake.setPaginate(() => [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "bot", id: 1 } }]);
    fake.add("dismissReview", () => Object.assign(new Error("already"), { status: 422 }));
    await adapter.dismissStaleReviews(5);
  });

  it("lists review comments", async () => {
    fake.setPaginate(() => [
      { id: 10, user: { login: "alice" }, body: "hi", created_at: "2026-01-01" },
    ]);
    const comments = await adapter.getReviewComments(5);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe("10");
    expect(comments[0]?.author).toBe("alice");
  });

  it("maps check conclusions", async () => {
    fake.add("get", () => ({
      number: 5,
      title: "t",
      state: "open",
      head: { ref: "x", sha: "S" },
      base: { ref: "main" },
      html_url: "u",
    }));
    fake.setPaginate(() => [
      { name: "ci", conclusion: "success", html_url: "u1" },
      { name: "build", conclusion: "failure", html_url: "u2" },
      { name: "pending", conclusion: null, html_url: "u3" },
    ]);
    const checks = await adapter.getChecks(5);
    expect(checks.map((c) => c.conclusion)).toEqual(["success", "failure", null]);
  });

  it("parseWebhookEvent returns null before identity warm-up and audits", () => {
    const auditMessages: string[] = [];
    const client = new GitHubClient({
      auth: new StubAuth(),
      octokit: fake.octokit as GitHubClient["octokit"],
      sleep: () => Promise.resolve(),
    });
    const local = new GitHubSourceControlAdapter({
      client,
      owner: "me",
      repo: "r",
      webhookSecret: null,
      audit: (msg) => auditMessages.push(msg),
    });
    const result = local.parseWebhookEvent(
      { "x-github-event": "issues" },
      JSON.stringify({ action: "labeled", issue: { number: 1 }, label: { name: "rq:phase:x" } }),
    );
    expect(result).toBeNull();
    expect(auditMessages.some((m) => m.includes("identity not warmed"))).toBe(true);
  });

  it("parseWebhookEvent works after warmIdentity", async () => {
    await adapter.warmIdentity();
    const payload = JSON.stringify({
      action: "labeled",
      sender: { login: "alice", id: 2 },
      issue: { number: 9 },
      label: { name: "rq:phase:coding" },
    });
    const result = adapter.parseWebhookEvent({ "x-github-event": "issues" }, payload);
    expect(result?.type).toBe("phase-change");
  });

  it("validateConfig accepts minimal config", () => {
    expect(() => {
      adapter.validateConfig({ owner: "o", repo: "r" });
    }).not.toThrow();
  });

  it("validateConfig rejects missing fields", () => {
    expect(() => {
      adapter.validateConfig({ owner: "o" });
    }).toThrow();
  });
});
