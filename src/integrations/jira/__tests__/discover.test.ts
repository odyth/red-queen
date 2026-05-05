import { describe, expect, it } from "vitest";
import { JiraClient } from "../client.js";
import { discoverJiraSchema, matchPhases } from "../discover.js";

type FetchFn = typeof fetch;

function toUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function routedFetch(routes: { match: RegExp; body: unknown }[]): {
  fetchImpl: FetchFn;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchFn = ((input: RequestInfo | URL) => {
    const url = toUrlString(input);
    calls.push(url);
    for (const route of routes) {
      if (route.match.test(url)) {
        return Promise.resolve(jsonResponse(route.body));
      }
    }
    return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
  }) as FetchFn;
  return { fetchImpl, calls };
}

function buildClient(fetchImpl: FetchFn): JiraClient {
  return new JiraClient({
    baseUrl: "https://example.atlassian.net",
    email: "a@b.com",
    apiToken: "t",
    fetchImpl,
  });
}

describe("discoverJiraSchema", () => {
  it("selects the single-select custom field whose name contains 'phase'", async () => {
    const { fetchImpl } = routedFetch([
      {
        match: /\/context\/ctx-1\/option$/,
        body: {
          values: [
            { id: "10001", value: "Spec Writing" },
            { id: "10002", value: "Spec Review" },
            { id: "10003", value: "Coding" },
          ],
        },
      },
      {
        match: /\/field\/customfield_10234\/context$/,
        body: { values: [{ id: "ctx-1", name: "default", isGlobalContext: true }] },
      },
      {
        match: /\/rest\/api\/3\/field$/,
        body: [
          {
            id: "customfield_10234",
            name: "AI Phase",
            schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
          },
          {
            id: "customfield_99999",
            name: "Deploy Stage",
            schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
          },
          {
            id: "customfield_10567",
            name: "AI Spec",
            schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" },
          },
        ],
      },
    ]);

    const client = buildClient(fetchImpl);
    const result = await discoverJiraSchema({
      client,
      phases: [
        { name: "spec-writing", label: "Spec Writing" },
        { name: "spec-review", label: "Spec Review" },
        { name: "coding", label: "Coding" },
      ],
    });

    expect(result.phaseFieldCandidates.length).toBe(1);
    expect(result.phaseFieldCandidates[0]?.id).toBe("customfield_10234");
    expect(result.specFieldCandidates[0]?.id).toBe("customfield_10567");
    expect(result.phaseMatches.every((m) => m.matched !== null)).toBe(true);
    expect(result.phaseMatches[0]?.matched?.optionId).toBe("10001");
  });

  it("returns multiple phase candidates when several select fields name 'phase'", async () => {
    const { fetchImpl } = routedFetch([
      { match: /\/context\/ctx-1\/option$/, body: { values: [] } },
      { match: /\/field\/customfield_10001\/context$/, body: { values: [{ id: "ctx-1" }] } },
      {
        match: /\/rest\/api\/3\/field$/,
        body: [
          {
            id: "customfield_10001",
            name: "AI Phase",
            schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
          },
          {
            id: "customfield_10002",
            name: "Deploy Phase",
            schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
          },
          {
            id: "customfield_10003",
            name: "AI Spec",
            schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" },
          },
        ],
      },
    ]);
    const client = buildClient(fetchImpl);
    const result = await discoverJiraSchema({ client, phases: [] });
    expect(result.phaseFieldCandidates.map((c) => c.id)).toEqual([
      "customfield_10001",
      "customfield_10002",
    ]);
  });
});

describe("matchPhases", () => {
  const options = [
    { id: "10001", value: "Spec Writing" },
    { id: "10002", value: "Spec Review" },
    { id: "10003", value: "Coding" },
    { id: "10010", value: "Code Feedback Loop" },
  ];

  it("matches on exact label first", () => {
    const m = matchPhases([{ name: "spec-writing", label: "Spec Writing" }], options);
    expect(m[0]?.matched).toEqual({
      optionId: "10001",
      optionValue: "Spec Writing",
      reason: "label",
    });
  });

  it("falls back to fuzzy match within Levenshtein distance 3", () => {
    // "Code Feedback" vs "Code Feedback Loop" — distance 5, above threshold.
    // "Coding" label-only (no explicit label) — match via fuzzy on name.
    const m = matchPhases([{ name: "spec-wrtng" /* misspelled */ }], options);
    expect(m[0]?.matched?.reason).toBe("fuzzy");
    expect(m[0]?.matched?.optionValue).toBe("Spec Writing");
  });

  it("returns null for phases with no match within threshold", () => {
    const m = matchPhases(
      [{ name: "absolutely-unrelated-phase", label: "No Such Thing" }],
      options,
    );
    expect(m[0]?.matched).toBeNull();
  });

  it("handles empty label by falling back to name", () => {
    const m = matchPhases([{ name: "coding" }], options);
    expect(m[0]?.matched?.reason).toBe("name");
    expect(m[0]?.matched?.optionId).toBe("10003");
  });
});
