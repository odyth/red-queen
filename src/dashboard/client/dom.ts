// Return-only generics let callers narrow the query result without
// casting at every call site.
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
export function qs<E extends Element = Element>(sel: string, root?: ParentNode): E | null {
  return (root ?? document).querySelector<E>(sel);
}

export function qsa<E extends Element = Element>(sel: string, root?: ParentNode): E[] {
  return Array.from((root ?? document).querySelectorAll<E>(sel));
}
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

export function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/[&<>"]/g, (c) => ESCAPE_MAP[c] ?? c);
}

export function fmtDuration(seconds: number): string {
  let s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return `${String(d)}d ${String(h)}h ${String(m)}m ${String(s)}s`;
}

export function fmtPriority(p: number): string {
  if (p === 0) {
    return '<span class="pill p0">P0</span>';
  }
  if (p === 1) {
    return '<span class="pill p1">P1</span>';
  }
  return `<span class="pill pN">P${String(p)}</span>`;
}
