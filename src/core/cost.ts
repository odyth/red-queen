import type { RunUsage } from "./types.js";

// USD per 1M tokens. Keep these close to Anthropic's public list price so the
// built-ins are useful out of the box; enterprise/Bedrock rates belong in
// pipeline.cost.pricing overrides.
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

// Keyed by both the Claude Code CLI alias (what users put in pipeline.model)
// and the fully-qualified model ID (what the API returns in usage metadata),
// so lookups work regardless of which form the caller has in hand.
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  "claude-opus-4-7": { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 },
};

const warnedModels = new Set<string>();

export function resolvePricing(
  model: string,
  overrides: Record<string, ModelPricing>,
): ModelPricing | null {
  if (Object.prototype.hasOwnProperty.call(overrides, model)) {
    return overrides[model] ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(DEFAULT_PRICING, model)) {
    return DEFAULT_PRICING[model] ?? null;
  }
  return null;
}

export function computeCost(
  usage: RunUsage,
  model: string,
  overrides: Record<string, ModelPricing>,
): number {
  const pricing = resolvePricing(model, overrides);
  if (pricing === null) {
    if (warnedModels.has(model) === false) {
      warnedModels.add(model);
      process.stderr.write(
        `warning (cost): no pricing for model '${model}' — add pipeline.cost.pricing.${model} to redqueen.yaml to capture cost. Tokens are still recorded.\n`,
      );
    }
    return 0;
  }
  const perMillion = 1_000_000;
  const input = (usage.inputTokens * pricing.input) / perMillion;
  const output = (usage.outputTokens * pricing.output) / perMillion;
  const cacheRead = (usage.cacheReadTokens * pricing.cacheRead) / perMillion;
  const cacheCreation = (usage.cacheCreationTokens * pricing.cacheCreation) / perMillion;
  return input + output + cacheRead + cacheCreation;
}

// Exposed for tests so a suite that exercises unknown-model behavior can
// reset state between cases.
export function __resetCostWarnings(): void {
  warnedModels.clear();
}
