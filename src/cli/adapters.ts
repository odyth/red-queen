import type { IssueTracker } from "../integrations/issue-tracker.js";
import type { SourceControl } from "../integrations/source-control.js";
import { CliError } from "./errors.js";
import { MockIssueTrackerAdapter, MockSourceControlAdapter } from "./mock-adapter.js";

export function constructIssueTracker(type: string, config: Record<string, unknown>): IssueTracker {
  void config;
  if (type === "mock") {
    return new MockIssueTrackerAdapter();
  }
  if (type === "jira") {
    throw new CliError("issueTracker 'jira' is a Phase 5 deliverable");
  }
  if (type === "github-issues") {
    throw new CliError("issueTracker 'github-issues' is a Phase 5 deliverable");
  }
  throw new CliError(`Unknown issueTracker type: ${type}`);
}

export function constructSourceControl(
  type: string,
  config: Record<string, unknown>,
): SourceControl {
  void config;
  if (type === "mock") {
    return new MockSourceControlAdapter();
  }
  if (type === "github") {
    throw new CliError("sourceControl 'github' is a Phase 5 deliverable");
  }
  throw new CliError(`Unknown sourceControl type: ${type}`);
}
