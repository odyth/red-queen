import type { WorkerResult } from "../../worker.js";

export function makeWorkerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    success: true,
    exitCode: 0,
    elapsed: 1,
    summary: "done",
    error: null,
    usage: null,
    reportedCostUsd: null,
    ...overrides,
  };
}
