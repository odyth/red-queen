// Pure formatting helpers for cost values. Shared between server (markdown
// rendering, Jira/GitHub adapters) and the dashboard client bundle — keep
// this module free of Node imports so tsconfig.client.json can include it.

// Shown on every cost comment. Cost is Claude Code's reported usage cost (or a
// token×pricing estimate when the CLI reports none), not your invoiced bill —
// flat-rate plans like Claude Max aren't charged per task.
export const COST_DISCLAIMER =
  "Estimated API-equivalent cost; actual billing depends on your plan (flat-rate plans like Claude Max aren't charged per task).";

export function formatUsd(n: number): string {
  if (n < 0.01 && n > 0) {
    return `<$0.01`;
  }
  return `$${n.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n === 0) {
    return "0";
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}
