import { describe, it } from "vitest";
import type { GitHubAuthStrategy, GitHubIdentity } from "../../github/auth.js";
import { GitHubClient } from "../../github/client.js";
import {
  assertValidateConfigReportsErrorsForEmpty,
  assertValidatePhaseMappingReturnsResult,
  assertValidateWebhookRejectsInvalid,
} from "../../__tests__/issue-tracker-contract.js";
import { GitHubIssuesAdapter } from "../adapter.js";

class StubAuth implements GitHubAuthStrategy {
  getToken(): Promise<string> {
    return Promise.resolve("abc");
  }
  getIdentity(): Promise<GitHubIdentity> {
    return Promise.resolve({ login: "bot", accountId: "1", isBot: true });
  }
}

function factory(): GitHubIssuesAdapter {
  const client = new GitHubClient({ auth: new StubAuth() });
  return new GitHubIssuesAdapter({
    client,
    owner: "me",
    repo: "r",
    webhookSecret: null,
  });
}

describe("GitHubIssuesAdapter contract", () => {
  it("validateWebhook rejects empty input", () => {
    assertValidateWebhookRejectsInvalid(factory());
  });

  it("validateConfig reports errors for empty config", () => {
    assertValidateConfigReportsErrorsForEmpty(factory());
  });

  it("validatePhaseMapping returns a result for any phase list", () => {
    assertValidatePhaseMappingReturnsResult(factory(), ["coding", "testing"]);
  });
});
