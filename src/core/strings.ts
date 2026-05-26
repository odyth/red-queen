import { createHash } from "node:crypto";

/**
 * Canonical spec normalization. Strips trailing whitespace per line and
 * leading/trailing blank lines so cosmetic edits (a stray trailing space, an
 * extra blank line at the top) don't read as a human modification. This is the
 * SINGLE source of truth for spec hashing — both `redqueen spec set` (when
 * recording last_ai_spec_hash) and the orchestrator's humanModifiedSpec
 * pre-compute run through here. Do not fork a second normalization in shell.
 */
export function normalizeSpec(body: string): string {
  return body
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * True when the current spec body differs from what the AI last wrote.
 *
 * - null / whitespace-only spec → false (the empty-spec case is handled
 *   separately by the spec_empty signal in the writer's branching matrix).
 * - non-empty spec + null lastAiSpecHash → true. This is the
 *   "human pre-populated the spec before any AI write" case: currentHash can
 *   never equal null, so the writer folds the human content as an inline edit.
 *   Intentional — do NOT special-case it away.
 * - otherwise → hashes compared after normalization.
 */
export function computeHumanModifiedSpec(
  specContent: string | null,
  lastAiSpecHash: string | null,
): boolean {
  if (specContent === null || specContent.trim() === "") {
    return false;
  }
  const currentHash = sha256Hex(normalizeSpec(specContent));
  return currentHash !== lastAiSpecHash;
}

/**
 * Classic Wagner-Fischer Levenshtein edit distance. O(mn) time, O(mn) space.
 * Used for "did you mean ...?" suggestions across config validation and the
 * Jira discover command's phase-option matching.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use a flat array for the DP table — avoids non-null assertions on nested access.
  const dp = new Array<number>((m + 1) * (n + 1)).fill(0);
  const idx = (i: number, j: number): number => i * (n + 1) + j;

  for (let i = 0; i <= m; i++) {
    dp[idx(i, 0)] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[idx(0, j)] = j;
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (dp[idx(i - 1, j)] ?? 0) + 1;
      const ins = (dp[idx(i, j - 1)] ?? 0) + 1;
      const sub = (dp[idx(i - 1, j - 1)] ?? 0) + cost;
      dp[idx(i, j)] = Math.min(del, ins, sub);
    }
  }

  return dp[idx(m, n)] ?? 0;
}
