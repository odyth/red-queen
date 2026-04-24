import { expect } from "vitest";
import type { SourceControl } from "../source-control.js";

export function assertValidateWebhookRejectsInvalid(sc: SourceControl): void {
  const result = sc.validateWebhook({}, "");
  expect(result).toBe(false);
}

export function assertValidateConfigRejectsEmpty(sc: SourceControl): void {
  expect(() => {
    sc.validateConfig({});
  }).toThrow();
}
