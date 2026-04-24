import { describe, it } from "vitest";
import type { GitHubAuthStrategy, GitHubIdentity } from "../auth.js";
import {
  assertValidateConfigRejectsEmpty,
  assertValidateWebhookRejectsInvalid,
} from "../../__tests__/source-control-contract.js";
import { GitHubSourceControlAdapter } from "../adapter.js";
import { GitHubClient } from "../client.js";

class StubAuth implements GitHubAuthStrategy {
  getToken(): Promise<string> {
    return Promise.resolve("abc");
  }
  getIdentity(): Promise<GitHubIdentity> {
    return Promise.resolve({ login: "bot", accountId: "1", isBot: true });
  }
}

function factory(): GitHubSourceControlAdapter {
  const client = new GitHubClient({ auth: new StubAuth() });
  return new GitHubSourceControlAdapter({
    client,
    owner: "me",
    repo: "r",
    webhookSecret: null,
  });
}

describe("GitHubSourceControlAdapter contract", () => {
  it("validateWebhook rejects empty input", () => {
    assertValidateWebhookRejectsInvalid(factory());
  });

  it("validateConfig rejects empty config", () => {
    assertValidateConfigRejectsEmpty(factory());
  });
});
