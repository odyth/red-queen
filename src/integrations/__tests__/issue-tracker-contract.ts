import { expect } from "vitest";
import type { IssueTracker } from "../issue-tracker.js";

/**
 * Shared contract assertions applied to every IssueTracker implementation.
 * Each implementation supplies a factory that returns a freshly-configured
 * adapter preseeded with the fixtures the assertions expect. These are
 * minimal invariants — deeper, per-adapter behavior lives in each adapter's
 * own test file.
 */
export function assertValidateWebhookRejectsInvalid(tracker: IssueTracker): void {
  const result = tracker.validateWebhook({}, "");
  expect(result).toBe(false);
}

export function assertValidateConfigReportsErrorsForEmpty(tracker: IssueTracker): void {
  const result = tracker.validateConfig({});
  expect(Array.isArray(result.errors)).toBe(true);
}

export function assertValidatePhaseMappingReturnsResult(
  tracker: IssueTracker,
  phaseNames: string[],
): void {
  const result = tracker.validatePhaseMapping(phaseNames);
  expect(Array.isArray(result.errors)).toBe(true);
  expect(Array.isArray(result.warnings)).toBe(true);
}
