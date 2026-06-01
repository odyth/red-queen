import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JiraClient } from "../client.js";
import { JiraIssueTrackerAdapter } from "../adapter.js";
import type { JiraAdapterConfig } from "../adapter.js";

type FetchFn = typeof fetch;

interface MockCall {
  method: string;
  url: string;
  body: string | null;
}

function toUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function bodyToString(body: BodyInit): string {
  if (typeof body === "string") {
    return body;
  }
  return "<binary>";
}

function mkHarness(): {
  adapter: JiraIssueTrackerAdapter;
  setResponse(matcher: (call: MockCall) => boolean, body: unknown, status?: number): void;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const handlers: {
    matcher: (call: MockCall) => boolean;
    body: unknown;
    status: number;
  }[] = [];
  const fetchImpl: FetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = toUrlString(input);
    const body = init?.body === undefined ? null : bodyToString(init.body);
    const method = (init?.method ?? "GET").toUpperCase();
    const call = { method, url, body };
    calls.push(call);
    const handler = handlers.find((h) => h.matcher(call));
    if (handler === undefined) {
      return Promise.reject(new Error(`unmocked call: ${method} ${url}`));
    }
    const hasBody = handler.status !== 204 && handler.status !== 205;
    const bodyPayload = hasBody
      ? typeof handler.body === "string"
        ? handler.body
        : JSON.stringify(handler.body)
      : null;
    return Promise.resolve(
      new Response(bodyPayload, {
        status: handler.status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as FetchFn;

  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net",
    email: "a@b.com",
    apiToken: "x",
    fetchImpl,
    sleep: () => Promise.resolve(),
  });

  const config: JiraAdapterConfig = {
    baseUrl: "https://example.atlassian.net",
    email: "a@b.com",
    apiToken: "x",
    projectKey: "RQ",
    customFields: {
      phase: "customfield_10158",
      spec: "customfield_10157",
    },
    phaseMapping: {
      coding: { optionId: "10056", label: "Coding" },
      "code-review": { optionId: "10057", label: "Code Review" },
    },
    statusTransitions: {},
    reconcileScope: "active-sprint-or-all",
    botAccountId: "bot-1",
  };

  const adapter = new JiraIssueTrackerAdapter({ client, config });

  return {
    adapter,
    setResponse(matcher, body, status = 200) {
      handlers.push({ matcher, body, status });
    },
    calls,
  };
}

describe("JiraIssueTrackerAdapter", () => {
  let h: ReturnType<typeof mkHarness>;

  beforeEach(() => {
    h = mkHarness();
  });

  it("getIssue translates phase option to phase name", async () => {
    h.setResponse((c) => c.url.endsWith("/issue/RQ-1") && c.method === "GET", {
      id: "10000",
      key: "RQ-1",
      fields: {
        summary: "test",
        status: { name: "In Progress" },
        assignee: { accountId: "alice" },
        issuetype: { name: "Task" },
        labels: ["label-a"],
        created: "2026-01-01",
        updated: "2026-01-02",
        customfield_10158: { id: "10056" },
      },
    });
    const issue = await h.adapter.getIssue("RQ-1");
    expect(issue.phase).toBe("coding");
    expect(issue.summary).toBe("test");
    expect(issue.id).toBe("RQ-1");
  });

  it("listIssuesByPhase hits GET /search/jql with query string", async () => {
    // Sprint probe fires first (unscoped query to look for openSprints), then
    // the phase query. Match both via the presence of their JQL fragments.
    h.setResponse((c) => c.method === "GET" && c.url.includes("fields=summary&maxResults=1"), {
      issues: [],
      isLast: true,
    });
    h.setResponse((c) => c.method === "GET" && c.url.includes("customfield_10158"), {
      issues: [{ id: "10000", key: "RQ-7", fields: { summary: "s", issuetype: { name: "Task" } } }],
      isLast: true,
    });
    const issues = await h.adapter.listIssuesByPhase("coding");
    const phaseCall = h.calls.find(
      (c) => c.url.includes("/rest/api/3/search/jql") && c.url.includes("customfield_10158"),
    );
    expect(phaseCall?.method).toBe("GET");
    expect(phaseCall?.url).toContain("jql=");
    expect(phaseCall?.url).toContain("fields=");
    expect(phaseCall?.url).toContain("maxResults=100");
    // JQL must filter out Done status category (unquoted form)
    const parsedJql = new URL(phaseCall?.url ?? "").searchParams.get("jql") ?? "";
    expect(parsedJql).toContain("statusCategory != Done");
    // Phase clause must use cf[<id>] with an unquoted numeric option id — the
    // quoted "customfield_<id>" = "<id>" form silently returns zero rows in Jira.
    expect(parsedJql).toContain("cf[10158] = 10056");
    expect(parsedJql).not.toContain('"customfield_10158"');
    // Issue.id must be the Jira key, not the numeric id
    expect(issues[0]?.id).toBe("RQ-7");
  });

  it("listIssuesByPhase paginates via nextPageToken until isLast", async () => {
    h.setResponse((c) => c.method === "GET" && c.url.includes("fields=summary&maxResults=1"), {
      issues: [],
      isLast: true,
    });
    // First phase page returns nextPageToken, subsequent call uses it
    h.setResponse(
      (c) =>
        c.method === "GET" &&
        c.url.includes("customfield_10158") &&
        c.url.includes("nextPageToken") === false,
      {
        issues: [{ id: "1", key: "RQ-A", fields: { issuetype: { name: "Task" } } }],
        nextPageToken: "page2",
        isLast: false,
      },
    );
    h.setResponse((c) => c.method === "GET" && c.url.includes("nextPageToken=page2"), {
      issues: [{ id: "2", key: "RQ-B", fields: { issuetype: { name: "Task" } } }],
      isLast: true,
    });
    const issues = await h.adapter.listIssuesByPhase("coding");
    expect(issues.map((i) => i.id)).toEqual(["RQ-A", "RQ-B"]);
    const phaseCalls = h.calls.filter(
      (c) => c.url.includes("/rest/api/3/search/jql") && c.url.includes("customfield_10158"),
    );
    expect(phaseCalls).toHaveLength(2);
    expect(phaseCalls[1]?.url).toContain("nextPageToken=page2");
  });

  it("listIssuesByPhase scopes by sprint when active sprint exists", async () => {
    h.setResponse((c) => c.method === "GET" && c.url.includes("fields=summary&maxResults=1"), {
      issues: [{ id: "x", key: "RQ-X", fields: { issuetype: { name: "Task" } } }],
      isLast: true,
    });
    h.setResponse((c) => c.method === "GET" && c.url.includes("customfield_10158"), {
      issues: [],
      isLast: true,
    });
    await h.adapter.listIssuesByPhase("coding");
    const phaseCall = h.calls.find(
      (c) => c.url.includes("/rest/api/3/search/jql") && c.url.includes("customfield_10158"),
    );
    const jql = new URL(phaseCall?.url ?? "").searchParams.get("jql") ?? "";
    expect(jql).toContain("sprint in openSprints()");
  });

  it("setPhase sends PUT with option id", async () => {
    h.setResponse((c) => c.url.endsWith("/issue/RQ-1") && c.method === "PUT", {}, 204);
    await h.adapter.setPhase("RQ-1", "coding");
    const putCall = h.calls.find((c) => c.method === "PUT");
    expect(putCall?.body).toContain("10056");
  });

  it("setPhase throws on unmapped phase", async () => {
    await expect(h.adapter.setPhase("RQ-1", "nonexistent")).rejects.toThrow(/phaseMapping/);
    // No HTTP call should have been made
    expect(h.calls).toHaveLength(0);
  });

  it("assignToAi uses bot accountId", async () => {
    h.setResponse((c) => c.url.endsWith("/assignee"), {}, 204);
    await h.adapter.assignToAi("RQ-1");
    const call = h.calls[0];
    expect(call?.body).toContain("bot-1");
  });

  it("assignToHuman uses preferredAssignee and skips getIssue", async () => {
    h.setResponse((c) => c.url.endsWith("/assignee") && c.method === "PUT", {}, 204);
    await h.adapter.assignToHuman("RQ-1", "delegator-42");
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0];
    expect(call?.method).toBe("PUT");
    expect(call?.url).toContain("/assignee");
    expect(call?.body).toContain("delegator-42");
  });

  it("assignToHuman falls back to reporter when preferredAssignee is null", async () => {
    h.setResponse((c) => c.url.endsWith("/issue/RQ-1") && c.method === "GET", {
      id: "1",
      key: "RQ-1",
      fields: {
        reporter: { accountId: "reporter-7" },
        issuetype: { name: "Task" },
      },
    });
    h.setResponse((c) => c.url.endsWith("/assignee") && c.method === "PUT", {}, 204);
    await h.adapter.assignToHuman("RQ-1", null);
    const putCall = h.calls.find((c) => c.method === "PUT");
    expect(putCall?.body).toContain("reporter-7");
  });

  it("assignToHuman falls back to reporter when argument omitted", async () => {
    h.setResponse((c) => c.url.endsWith("/issue/RQ-1") && c.method === "GET", {
      id: "1",
      key: "RQ-1",
      fields: {
        reporter: { accountId: "reporter-9" },
        issuetype: { name: "Task" },
      },
    });
    h.setResponse((c) => c.url.endsWith("/assignee") && c.method === "PUT", {}, 204);
    await h.adapter.assignToHuman("RQ-1");
    const putCall = h.calls.find((c) => c.method === "PUT");
    expect(putCall?.body).toContain("reporter-9");
  });

  it("getSpec reads custom field as ADF", async () => {
    h.setResponse((c) => c.url.includes("/issue/RQ-1"), {
      id: "1",
      key: "RQ-1",
      fields: {
        customfield_10157: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
        },
      },
    });
    const spec = await h.adapter.getSpec("RQ-1");
    expect(spec).toContain("hello");
  });

  it("setSpec wraps content in ADF", async () => {
    h.setResponse((c) => c.method === "PUT" && c.url.endsWith("/issue/RQ-1"), {}, 204);
    await h.adapter.setSpec("RQ-1", "new content");
    const call = h.calls[0];
    expect(call?.body).toContain('"type":"doc"');
    expect(call?.body).toContain("new content");
  });

  it("addComment sends ADF", async () => {
    h.setResponse((c) => c.url.endsWith("/comment") && c.method === "POST", {
      id: "c-1",
    });
    await h.adapter.addComment("RQ-1", "nice");
    const call = h.calls[0];
    expect(call?.body).toContain('"type":"doc"');
  });

  it("getComments renders body via fromAdf", async () => {
    h.setResponse((c) => c.url.endsWith("/comment") && c.method === "GET", {
      comments: [
        {
          id: "c-1",
          author: { displayName: "alice" },
          body: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
          },
          created: "2026-01-01",
        },
      ],
    });
    const comments = await h.adapter.getComments("RQ-1");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("hi");
  });

  it("listAttachments maps raw shape", async () => {
    h.setResponse((c) => c.url.includes("/issue/RQ-1"), {
      id: "1",
      key: "RQ-1",
      fields: {
        attachment: [
          { id: "a1", filename: "x.png", mimeType: "image/png", size: 100, content: "u1" },
        ],
      },
    });
    const list = await h.adapter.listAttachments("RQ-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.filename).toBe("x.png");
  });

  it("transitionTo resolves transition by name", async () => {
    h.setResponse((c) => c.url.endsWith("/transitions") && c.method === "GET", {
      transitions: [
        { id: "21", name: "Start", to: { name: "In Progress" } },
        { id: "31", name: "Done", to: { name: "Done" } },
      ],
    });
    h.setResponse((c) => c.url.endsWith("/issue/RQ-1") && c.method === "GET", {
      id: "1",
      key: "RQ-1",
      fields: { issuetype: { name: "Task" } },
    });
    h.setResponse((c) => c.url.endsWith("/transitions") && c.method === "POST", {}, 204);
    await h.adapter.transitionTo("RQ-1", "In Progress");
    const postCall = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/transitions"));
    expect(postCall?.body).toContain('"id":"21"');
  });

  it("transitionTo throws if no matching transition", async () => {
    h.setResponse((c) => c.url.endsWith("/issue/RQ-1") && c.method === "GET", {
      id: "1",
      key: "RQ-1",
      fields: { issuetype: { name: "Task" } },
    });
    h.setResponse((c) => c.url.endsWith("/transitions") && c.method === "GET", {
      transitions: [{ id: "21", name: "Start", to: { name: "In Progress" } }],
    });
    await expect(h.adapter.transitionTo("RQ-1", "Missing")).rejects.toThrow();
  });

  it("validateConfig reports errors on bad config", () => {
    const result = h.adapter.validateConfig({});
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("validatePhaseMapping errors on unmapped phases", () => {
    const result = h.adapter.validatePhaseMapping(["coding", "missing"]);
    expect(result.warnings).toEqual([]);
    expect(result.errors.some((e) => e.includes("missing"))).toBe(true);
  });

  it("parseWebhookEvent returns phase-change", () => {
    const body = JSON.stringify({
      webhookEvent: "jira:issue_updated",
      user: { accountId: "human-1" },
      issue: { key: "RQ-1" },
      changelog: {
        items: [{ fieldId: "customfield_10158", to: "10056" }],
      },
    });
    const result = h.adapter.parseWebhookEvent({}, body);
    expect(result?.type).toBe("phase-change");
    expect(result?.payload.phase).toBe("coding");
  });
});

describe("JiraIssueTrackerAdapter downloadAttachment", () => {
  let tmpDir: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rq-jira-attach-"));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildAdapter(maxAttachmentBytes?: number): JiraIssueTrackerAdapter {
    const client = new JiraClient({
      baseUrl: "https://example.atlassian.net",
      email: "a@b.com",
      apiToken: "x",
      fetchImpl: (() => Promise.reject(new Error("not used"))) as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    const config: JiraAdapterConfig = {
      baseUrl: "https://example.atlassian.net",
      email: "a@b.com",
      apiToken: "x",
      projectKey: "RQ",
      customFields: { phase: "customfield_10158", spec: "customfield_10157" },
      phaseMapping: { coding: { optionId: "10056" } },
      statusTransitions: {},
      botAccountId: "bot-1",
    };
    return new JiraIssueTrackerAdapter({
      client,
      config,
      ...(maxAttachmentBytes !== undefined ? { maxAttachmentBytes } : {}),
    });
  }

  it("writes file within cap", async () => {
    const payload = Buffer.from("hello world");
    globalThis.fetch = (() =>
      Promise.resolve(new Response(payload, { status: 200 }))) as typeof fetch;
    const adapter = buildAdapter(1024);
    const destPath = join(tmpDir, "file.bin");
    await adapter.downloadAttachment(
      {
        id: "a1",
        filename: "file.bin",
        contentType: "application/octet-stream",
        sizeBytes: payload.length,
        url: "https://example.com/att",
        localPath: null,
      },
      destPath,
    );
    expect(readFileSync(destPath).toString()).toBe("hello world");
  });

  it("rejects and cleans up when stream exceeds cap", async () => {
    const payload = Buffer.alloc(1024, 1);
    globalThis.fetch = (() =>
      Promise.resolve(new Response(payload, { status: 200 }))) as typeof fetch;
    const adapter = buildAdapter(64);
    const destPath = join(tmpDir, "huge.bin");
    await expect(
      adapter.downloadAttachment(
        {
          id: "a2",
          filename: "huge.bin",
          contentType: "application/octet-stream",
          sizeBytes: 0,
          url: "https://example.com/huge",
          localPath: null,
        },
        destPath,
      ),
    ).rejects.toThrow(/size cap/);
    expect(() => readFileSync(destPath)).toThrow();
  });
});
