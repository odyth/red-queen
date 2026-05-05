import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDiscoveryToConfig } from "../jira.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rq-jira-cli-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedYaml(): string {
  return [
    "# Red Queen config",
    "issueTracker:",
    "  type: jira",
    "  config:",
    "    # jira connection",
    "    baseUrl: https://example.atlassian.net",
    "    email: a@b.com",
    "    apiToken: ${JIRA_TOKEN}",
    "    projectKey: AS",
    "    customFields:",
    "      phase: <CHANGE ME>",
    "      spec: <CHANGE ME>",
    "    phaseMapping:",
    "      spec-writing: { optionId: <CHANGE ME> }",
    "      coding: { optionId: <CHANGE ME> }",
    "      blocked: { optionId: <CHANGE ME> }",
    "sourceControl:",
    "  type: github",
    "",
  ].join("\n");
}

describe("writeDiscoveryToConfig", () => {
  it("writes phase/spec ids, fills matched phaseMapping, leaves unmatched as <CHANGE ME>", () => {
    const configPath = join(tmp, "redqueen.yaml");
    writeFileSync(configPath, seedYaml(), "utf8");

    writeDiscoveryToConfig(configPath, {
      phaseFieldId: "customfield_10234",
      specFieldId: "customfield_10567",
      matches: [
        {
          phaseName: "spec-writing",
          matched: { optionId: "10001", optionValue: "Spec Writing", reason: "label" },
        },
        {
          phaseName: "coding",
          matched: { optionId: "10003", optionValue: "Coding", reason: "label" },
        },
        { phaseName: "blocked", matched: null },
      ],
    });

    const rewritten = readFileSync(configPath, "utf8");
    expect(rewritten).toContain("phase: customfield_10234");
    expect(rewritten).toContain("spec: customfield_10567");
    expect(rewritten).toContain('optionId: "10001"');
    expect(rewritten).toContain('optionId: "10003"');
    // Comments preserved.
    expect(rewritten).toContain("# Red Queen config");
    expect(rewritten).toContain("# jira connection");
    // Unmatched phase stays as <CHANGE ME>.
    expect(rewritten).toContain("blocked: { optionId: <CHANGE ME> }");
  });

  it("is idempotent when run twice with the same inputs", () => {
    const configPath = join(tmp, "redqueen.yaml");
    writeFileSync(configPath, seedYaml(), "utf8");

    const input = {
      phaseFieldId: "customfield_10234",
      specFieldId: "customfield_10567",
      matches: [
        {
          phaseName: "spec-writing",
          matched: { optionId: "10001", optionValue: "Spec Writing", reason: "label" as const },
        },
      ],
    };

    writeDiscoveryToConfig(configPath, input);
    const first = readFileSync(configPath, "utf8");
    writeDiscoveryToConfig(configPath, input);
    const second = readFileSync(configPath, "utf8");
    expect(second).toBe(first);
  });
});
