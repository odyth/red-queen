export const SPEC_MARKER = "<!-- redqueen:spec -->";

export interface SpecLookup {
  content: string | null;
  markerCommentId: number | null;
  duplicateCount: number;
}

export interface SpecComment {
  id: number;
  body: string | null;
  created_at?: string;
}

export function findSpec(comments: SpecComment[]): SpecLookup {
  const markers: SpecComment[] = comments.filter((c) => c.body?.startsWith(SPEC_MARKER) === true);
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
  const content = body.slice(SPEC_MARKER.length).replace(/^\r?\n/, "");
  return {
    content,
    markerCommentId: target.id,
    duplicateCount: markers.length - 1,
  };
}

export function formatSpecBody(content: string): string {
  return `${SPEC_MARKER}\n${content}`;
}
