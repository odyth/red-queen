import { describe, it } from "vitest";
import {
  assertValidateConfigReportsErrorsForEmpty,
  assertValidatePhaseMappingReturnsResult,
  assertValidateWebhookRejectsInvalid,
} from "../../__tests__/issue-tracker-contract.js";
import { JiraClient } from "../client.js";
import { JiraIssueTrackerAdapter } from "../adapter.js";
import type { JiraAdapterConfig } from "../adapter.js";

function factory(): JiraIssueTrackerAdapter {
  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net",
    email: "a@b.com",
    apiToken: "x",
    fetchImpl: (() => Promise.reject(new Error("not called"))) as typeof fetch,
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
  return new JiraIssueTrackerAdapter({ client, config });
}

describe("JiraIssueTrackerAdapter contract", () => {
  it("validateWebhook rejects empty input", () => {
    assertValidateWebhookRejectsInvalid(factory());
  });

  it("validateConfig reports errors for empty config", () => {
    assertValidateConfigReportsErrorsForEmpty(factory());
  });

  it("validatePhaseMapping returns a result for any phase list", () => {
    assertValidatePhaseMappingReturnsResult(factory(), ["coding", "missing"]);
  });
});
