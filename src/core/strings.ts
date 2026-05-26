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
