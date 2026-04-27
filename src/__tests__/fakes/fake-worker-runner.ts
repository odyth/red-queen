import { readFileSync } from "node:fs";
import type { WorkerRunner } from "../../core/orchestrator.js";
import type { WorkerResult } from "../../core/worker.js";

export interface FakeWorkerCall {
  phaseName: string;
  promptPath: string;
  promptBody: string;
  callIndex: number;
}

export type DispatchRule = (call: FakeWorkerCall) => WorkerResult | null;

const TEMP_PATH_RE = /^Read and follow (.+) exactly\.$/;
const PHASE_NAME_RE = /^phaseName:\s*(\S+)/m;

export function createFakeWorkerRunner(rules: DispatchRule[]): WorkerRunner {
  let callIndex = 0;
  return (options) => {
    const match = TEMP_PATH_RE.exec(options.prompt.trim());
    if (match === null) {
      throw new Error(`fake-worker: unexpected prompt shape: ${options.prompt.slice(0, 200)}`);
    }
    const promptPath = match[1] ?? "";
    const promptBody = readFileSync(promptPath, "utf8");
    const phaseMatch = PHASE_NAME_RE.exec(promptBody);
    if (phaseMatch === null) {
      throw new Error(`fake-worker: phaseName not found in ${promptPath}`);
    }
    const call: FakeWorkerCall = {
      phaseName: phaseMatch[1] ?? "",
      promptPath,
      promptBody,
      callIndex,
    };
    callIndex++;
    for (const rule of rules) {
      const result = rule(call);
      if (result !== null) {
        return Promise.resolve(result);
      }
    }
    throw new Error(`fake-worker: no rule matched phase "${call.phaseName}"`);
  };
}

export function phaseRule(
  phaseName: string,
  summary: string,
  overrides: Partial<WorkerResult> = {},
): DispatchRule {
  return (call) => {
    if (call.phaseName !== phaseName) {
      return null;
    }
    return {
      success: true,
      exitCode: 0,
      elapsed: 1,
      summary,
      error: null,
      ...overrides,
    };
  };
}
