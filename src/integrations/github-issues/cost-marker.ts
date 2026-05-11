export const COST_MARKER = "<!-- redqueen:cost -->";

export interface CostLookup {
  content: string | null;
  markerCommentId: number | null;
  duplicateCount: number;
}

export interface CostComment {
  id: number;
  body: string | null;
  created_at?: string;
}

export function findCost(comments: CostComment[]): CostLookup {
  const markers: CostComment[] = comments.filter((c) => c.body?.startsWith(COST_MARKER) === true);
  if (markers.length === 0) {
    return { content: null, markerCommentId: null, duplicateCount: 0 };
  }
  const sorted = [...markers].sort((a, b) => {
    const ad = a.created_at ?? "";
    const bd = b.created_at ?? "";
    return bd.localeCompare(ad);
  });
  const target = sorted[0];
  if (target === undefined) {
    return { content: null, markerCommentId: null, duplicateCount: 0 };
  }
  const body = target.body ?? "";
  const content = body.slice(COST_MARKER.length).replace(/^\r?\n/, "");
  return {
    content,
    markerCommentId: target.id,
    duplicateCount: markers.length - 1,
  };
}

export function formatCostBody(markdown: string): string {
  return `${COST_MARKER}\n${markdown}`;
}
