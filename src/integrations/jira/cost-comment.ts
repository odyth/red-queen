import type { AdfNode } from "./adf.js";

// Leading text of the cost comment. Jira comments are ADF and can't carry an
// invisible HTML marker the way GitHub does, so the visible title doubles as
// the upsert marker — we find our comment by matching this prefix in its text.
export const JIRA_COST_MARKER = "Red Queen cost summary";

export interface RawJiraComment {
  id: string;
  body?: AdfNode;
  created?: string;
}

export interface CostCommentLookup {
  commentId: string | null;
  duplicateCount: number;
}

// Finds the existing cost comment (if any) so the adapter can update it in
// place instead of stacking a fresh comment after every phase. When more than
// one match exists we keep the newest and report the rest as duplicates.
export function findCostComment(comments: RawJiraComment[]): CostCommentLookup {
  const matches = comments.filter((c) => hasCostMarker(c.body));
  if (matches.length === 0) {
    return { commentId: null, duplicateCount: 0 };
  }
  const newestFirst = [...matches].sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
  return { commentId: newestFirst[0]?.id ?? null, duplicateCount: matches.length - 1 };
}

function hasCostMarker(body: AdfNode | undefined): boolean {
  if (body === undefined) {
    return false;
  }
  return adfPlainText(body).trimStart().startsWith(JIRA_COST_MARKER);
}

function adfPlainText(node: AdfNode): string {
  const parts: string[] = [];
  const walk = (n: AdfNode): void => {
    if (typeof n.text === "string") {
      parts.push(n.text);
    }
    for (const child of n.content ?? []) {
      walk(child);
    }
  };
  walk(node);
  return parts.join("");
}
