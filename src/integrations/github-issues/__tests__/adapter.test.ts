import { describe, it, expect, beforeEach } from "vitest";
import type { GitHubAuthStrategy, GitHubIdentity } from "../../github/auth.js";
import { GitHubClient } from "../../github/client.js";
import { GitHubIssuesAdapter } from "../adapter.js";

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface Call {
  label: string;
  args: Record<string, unknown>;
}

function buildFakeOctokit(): {
  add(path: string, responder: (args: Record<string, unknown>) => unknown): void;
  octokit: unknown;
  calls: Call[];
  setPaginate(fn: (path: string, args: Record<string, unknown>) => unknown[]): void;
} {
  const routes = new Map<string, (args: Record<string, unknown>) => unknown>();
  const calls: Call[] = [];
  let paginate: (path: string, args: Record<string, unknown>) => unknown[] = () => [];

  const makeCall = (path: string): ((args: Record<string, unknown>) => Promise<unknown>) => {
    const fn = function named(args: Record<string, unknown>): Promise<unknown> {
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
    return fn;
  };

  const routeProxyHandler = {
    get(_target: unknown, prop: string): (args: Record<string, unknown>) => Promise<unknown> {
      return makeCall(prop);
    },
  };

  const octokit = {
    rest: {
      issues: new Proxy({}, routeProxyHandler),
      repos: new Proxy({}, routeProxyHandler),
      pulls: new Proxy({}, routeProxyHandler),
      git: new Proxy({}, routeProxyHandler),
      checks: new Proxy({}, routeProxyHandler),
    },
    paginate: (method: unknown, args: Record<string, unknown>): Promise<unknown[]> => {
      const fn = method as { name?: string };
      const path = fn.name ?? "";
      return Promise.resolve(paginate(path, args));
    },
  };

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
  identity: GitHubIdentity = { login: "bot", accountId: "1", isBot: true };
  getToken(): Promise<string> {
    return Promise.resolve("abc");
  }
  getIdentity(): Promise<GitHubIdentity> {
    return Promise.resolve(this.identity);
  }
}

describe("GitHubIssuesAdapter", () => {
  let fake: ReturnType<typeof buildFakeOctokit>;
  let adapter: GitHubIssuesAdapter;

  beforeEach(() => {
    fake = buildFakeOctokit();
    const client = new GitHubClient({
      auth: new StubAuth(),
      octokit: fake.octokit as GitHubClient["octokit"],
      sleep: () => Promise.resolve(),
    });
    adapter = new GitHubIssuesAdapter({
      client,
      owner: "me",
      repo: "r",
      webhookSecret: null,
    });
  });

  it("getIssue maps labels to phase and keeps assignee/reporter distinct", async () => {
    fake.add("get", () => ({
      number: 5,
      title: "t",
      state: "open",
      labels: [{ name: "bug" }, { name: "rq:phase:coding" }],
      assignee: { login: "bob" },
      user: { login: "alice" },
      created_at: "2026-01-01",
      updated_at: "2026-01-02",
    }));
    const issue = await adapter.getIssue("#5");
    expect(issue.phase).toBe("coding");
    expect(issue.assignee).toBe("bob");
    expect(issue.reporter).toBe("alice");
    expect(issue.labels).toContain("bug");
  });

  it("setPhase ensures label exists before adding", async () => {
    let labelCreated = false;
    fake.add("get", () => ({
      number: 5,
      title: "t",
      state: "open",
      labels: [],
      assignee: null,
      user: null,
      created_at: "",
      updated_at: "",
    }));
    fake.add("getLabel", () => Object.assign(new Error("nope"), { status: 404 }));
    fake.add("createLabel", () => {
      labelCreated = true;
      return {};
    });
    fake.add("addLabels", () => ({}));
    await adapter.setPhase("#5", "coding");
    expect(labelCreated).toBe(true);
    const addLabels = fake.calls.find((c) => c.label === "addLabels");
    expect(addLabels?.args.labels).toEqual(["rq:phase:coding"]);
  });

  it("setPhase removes stale phase labels", async () => {
    fake.add("get", () => ({
      number: 5,
      title: "t",
      state: "open",
      labels: [{ name: "rq:phase:coding" }, { name: "bug" }],
      assignee: null,
      user: null,
      created_at: "",
      updated_at: "",
    }));
    fake.add("getLabel", () => ({}));
    fake.add("removeLabel", () => ({}));
    fake.add("addLabels", () => ({}));
    await adapter.setPhase("#5", "code-review");
    const removed = fake.calls.find((c) => c.label === "removeLabel");
    expect(removed?.args.name).toBe("rq:phase:coding");
    const added = fake.calls.find((c) => c.label === "addLabels");
    expect(added?.args.labels).toEqual(["rq:phase:code-review"]);
  });

  it("assignToAi adds active label", async () => {
    fake.add("getLabel", () => ({}));
    fake.add("addLabels", () => ({}));
    await adapter.assignToAi("#5");
    const added = fake.calls.find((c) => c.label === "addLabels");
    expect(added?.args.labels).toEqual(["rq:active"]);
  });

  it("assignToHuman removes active label and comments", async () => {
    fake.add("removeLabel", () => ({}));
    fake.add("get", () => ({
      number: 5,
      title: "t",
      state: "open",
      labels: [],
      assignee: null,
      user: { login: "alice" },
      created_at: "",
      updated_at: "",
    }));
    fake.add("createComment", () => ({}));
    fake.add("addAssignees", () => ({}));
    await adapter.assignToHuman("#5");
    const comment = fake.calls.find((c) => c.label === "createComment");
    expect(stringArg(comment?.args.body)).toContain("@alice");
  });

  it("assignToHuman prefers preferredAssignee over reporter", async () => {
    fake.add("removeLabel", () => ({}));
    fake.add("get", () => ({
      number: 5,
      title: "t",
      state: "open",
      labels: [],
      assignee: null,
      user: { login: "alice" },
      created_at: "",
      updated_at: "",
    }));
    fake.add("createComment", () => ({}));
    fake.add("addAssignees", () => ({}));
    await adapter.assignToHuman("#5", "justin");
    const comment = fake.calls.find((c) => c.label === "createComment");
    expect(stringArg(comment?.args.body)).toContain("@justin");
    expect(stringArg(comment?.args.body)).not.toContain("@alice");
    const assignees = fake.calls.find((c) => c.label === "addAssignees");
    expect(assignees?.args.assignees).toEqual(["justin"]);
  });

  it("setSpec creates marker comment when none exists", async () => {
    fake.setPaginate(() => []);
    fake.add("createComment", () => ({ id: 1 }));
    await adapter.setSpec("#5", "hello");
    const create = fake.calls.find((c) => c.label === "createComment");
    expect(stringArg(create?.args.body)).toContain("<!-- redqueen:spec -->");
    expect(stringArg(create?.args.body)).toContain("hello");
  });

  it("setSpec updates existing marker comment", async () => {
    fake.setPaginate(() => [
      { id: 99, body: "<!-- redqueen:spec -->\nold", created_at: "2026-01-01" },
    ]);
    fake.add("updateComment", () => ({}));
    await adapter.setSpec("#5", "new");
    const update = fake.calls.find((c) => c.label === "updateComment");
    expect(update?.args.comment_id).toBe(99);
    expect(stringArg(update?.args.body)).toContain("new");
  });

  it("getSpec returns the most recent marker comment body", async () => {
    fake.setPaginate(() => [
      { id: 1, body: "<!-- redqueen:spec -->\nold", created_at: "2026-01-01" },
      { id: 2, body: "<!-- redqueen:spec -->\nnew", created_at: "2026-01-02" },
    ]);
    const spec = await adapter.getSpec("#5");
    expect(spec).toBe("new");
  });

  it("getSpec returns null when no marker", async () => {
    fake.setPaginate(() => [{ id: 1, body: "just a comment", created_at: "" }]);
    const spec = await adapter.getSpec("#5");
    expect(spec).toBeNull();
  });

  it("listAttachments is a no-op", async () => {
    expect(await adapter.listAttachments()).toEqual([]);
  });

  it("transitionTo is a no-op", async () => {
    await adapter.transitionTo();
  });

  it("validateConfig returns errors on missing fields", () => {
    const result = adapter.validateConfig({});
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("validateConfig accepts minimal config", () => {
    const result = adapter.validateConfig({ owner: "o", repo: "r" });
    expect(result.errors).toEqual([]);
  });

  it("parseWebhookEvent drops events before warmIdentity and audits", () => {
    const auditMessages: string[] = [];
    const client = new GitHubClient({
      auth: new StubAuth(),
      octokit: fake.octokit as GitHubClient["octokit"],
      sleep: () => Promise.resolve(),
    });
    const local = new GitHubIssuesAdapter({
      client,
      owner: "me",
      repo: "r",
      webhookSecret: null,
      audit: (msg) => auditMessages.push(msg),
    });
    const result = local.parseWebhookEvent(
      { "x-github-event": "issues" },
      JSON.stringify({
        action: "labeled",
        sender: { login: "alice", id: 2 },
        issue: { number: 1 },
        label: { name: "rq:phase:coding" },
      }),
    );
    expect(result).toBeNull();
    expect(auditMessages.some((m) => m.includes("identity not warmed"))).toBe(true);
  });

  it("parseWebhookEvent works after warmIdentity", async () => {
    await adapter.warmIdentity();
    const result = adapter.parseWebhookEvent(
      { "x-github-event": "issues" },
      JSON.stringify({
        action: "labeled",
        sender: { login: "alice", id: 2 },
        issue: { number: 9 },
        label: { name: "rq:phase:coding" },
      }),
    );
    expect(result?.type).toBe("phase-change");
  });
});
