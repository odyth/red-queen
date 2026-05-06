export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  marks?: AdfMark[];
  attrs?: Record<string, unknown>;
}

export interface AdfDocument extends AdfNode {
  type: "doc";
  version: number;
}

const MENTION_RE = /@accountId:([A-Za-z0-9:_-]+)/g;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const STRONG_RE = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/g;
const EM_STAR_RE = /\*([^*\n]+)\*/g;
const EM_UNDER_RE = /(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g;
const STRIKE_RE = /~~([^~\n]+)~~/g;

const FENCE_RE = /^```(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^>\s?(.*)$/;
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)\d+\.\s+(.*)$/;
const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;

type ListKind = "bullet" | "ordered" | "task";

/**
 * Converts markdown to ADF. Supports:
 * - Headings (#..######)
 * - Paragraphs (split on blank lines)
 * - Fenced code blocks (```lang\n…\n```)
 * - Blockquotes (> line)
 * - Bullet, ordered, and task lists (with one level of nesting)
 * - Horizontal rules (--- / *** / ___)
 * - Inline code (`code`)
 * - Bold (**text** / __text__), italic (*text* / _text_), strikethrough (~~text~~)
 * - Inline links ([text](url))
 * - Mentions (@accountId:<id>)
 * - Hard line breaks (\n inside a paragraph)
 *
 * Deliberately NOT supported: nested emphasis / marks inside other marks,
 * setext headings, HTML passthrough, reference-style links, tables.
 */
export function toAdf(markdown: string): AdfDocument {
  const lines = markdown.split(/\r?\n/);
  const content = parseBlocks(lines, 0, lines.length, 0);
  if (content.length === 0) {
    content.push({ type: "paragraph", content: [] });
  }
  return { type: "doc", version: 1, content };
}

function parseBlocks(lines: string[], start: number, end: number, minIndent: number): AdfNode[] {
  const blocks: AdfNode[] = [];
  let i = start;
  while (i < end) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const lang = (fence[1] ?? "").trim();
      const codeLines: string[] = [];
      i++;
      while (i < end) {
        const next = lines[i] ?? "";
        if (FENCE_RE.test(next)) {
          i++;
          break;
        }
        codeLines.push(next);
        i++;
      }
      blocks.push({
        type: "codeBlock",
        attrs: lang.length === 0 ? {} : { language: lang },
        content: [{ type: "text", text: codeLines.join("\n") }],
      });
      continue;
    }

    if (RULE_RE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      const level = Math.min(6, heading[1]?.length ?? 1);
      const text = heading[2] ?? "";
      blocks.push({
        type: "heading",
        attrs: { level },
        content: buildInline(text),
      });
      i++;
      continue;
    }

    const listKind = detectListKind(line, minIndent);
    if (listKind !== null) {
      const { node, next } = parseList(lines, i, end, listKind.indent, listKind.kind);
      blocks.push(node);
      i = next;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote !== null) {
      const quoteLines: string[] = [];
      while (i < end) {
        const match = QUOTE_RE.exec(lines[i] ?? "");
        if (match === null) {
          break;
        }
        quoteLines.push(match[1] ?? "");
        i++;
      }
      const paragraph = buildParagraph(quoteLines.join("\n"));
      blocks.push({
        type: "blockquote",
        content: paragraph === null ? [{ type: "paragraph", content: [] }] : [paragraph],
      });
      continue;
    }

    const paraLines: string[] = [];
    while (i < end) {
      const candidate = lines[i] ?? "";
      if (candidate.trim().length === 0) {
        break;
      }
      if (isBlockStart(candidate, minIndent)) {
        break;
      }
      paraLines.push(candidate);
      i++;
    }
    if (paraLines.length > 0) {
      const paragraph = buildParagraph(paraLines.join("\n"));
      if (paragraph !== null) {
        blocks.push(paragraph);
      }
    }
  }
  return blocks;
}

function isBlockStart(line: string, minIndent: number): boolean {
  if (FENCE_RE.test(line)) {
    return true;
  }
  if (RULE_RE.test(line)) {
    return true;
  }
  if (HEADING_RE.test(line)) {
    return true;
  }
  if (QUOTE_RE.test(line)) {
    return true;
  }
  return detectListKind(line, minIndent) !== null;
}

function detectListKind(
  line: string,
  minIndent: number,
): { kind: ListKind; indent: number } | null {
  const task = TASK_RE.exec(line);
  if (task !== null) {
    const indent = (task[1] ?? "").length;
    if (indent >= minIndent) {
      return { kind: "task", indent };
    }
  }
  const bullet = BULLET_RE.exec(line);
  if (bullet !== null) {
    const indent = (bullet[1] ?? "").length;
    if (indent >= minIndent) {
      return { kind: "bullet", indent };
    }
  }
  const ordered = ORDERED_RE.exec(line);
  if (ordered !== null) {
    const indent = (ordered[1] ?? "").length;
    if (indent >= minIndent) {
      return { kind: "ordered", indent };
    }
  }
  return null;
}

function matchListItem(
  line: string,
  kind: ListKind,
  indent: number,
): { text: string; state?: "TODO" | "DONE" } | null {
  if (kind === "task") {
    const m = TASK_RE.exec(line);
    if (m === null || (m[1] ?? "").length !== indent) {
      return null;
    }
    const mark = (m[2] ?? " ").toLowerCase();
    return { text: m[3] ?? "", state: mark === "x" ? "DONE" : "TODO" };
  }
  if (kind === "bullet") {
    // Task items are a specialization of bullet — don't claim them here.
    if (TASK_RE.test(line)) {
      return null;
    }
    const m = BULLET_RE.exec(line);
    if (m === null || (m[1] ?? "").length !== indent) {
      return null;
    }
    return { text: m[3] ?? "" };
  }
  const m = ORDERED_RE.exec(line);
  if (m === null || (m[1] ?? "").length !== indent) {
    return null;
  }
  return { text: m[2] ?? "" };
}

function parseList(
  lines: string[],
  start: number,
  end: number,
  indent: number,
  kind: ListKind,
): { node: AdfNode; next: number } {
  const items: AdfNode[] = [];
  let i = start;
  while (i < end) {
    const line = lines[i] ?? "";
    const item = matchListItem(line, kind, indent);
    if (item === null) {
      break;
    }
    i++;

    const itemContent: AdfNode[] = [{ type: "paragraph", content: buildInline(item.text) }];

    // A nested list is a list whose indent is strictly greater than the
    // current one. Blank lines before the nested block are allowed.
    let peek = i;
    while (peek < end && (lines[peek] ?? "").trim().length === 0) {
      peek++;
    }
    if (peek < end) {
      const nestedKind = detectListKind(lines[peek] ?? "", indent + 1);
      if (nestedKind !== null && nestedKind.indent > indent) {
        const nested = parseList(lines, peek, end, nestedKind.indent, nestedKind.kind);
        itemContent.push(nested.node);
        i = nested.next;
      }
    }

    if (kind === "task") {
      items.push({
        type: "taskItem",
        attrs: { state: item.state ?? "TODO", localId: null },
        content: itemContent[0]?.content ?? [{ type: "text", text: item.text }],
      });
    } else {
      items.push({ type: "listItem", content: itemContent });
    }
  }

  const wrapperType =
    kind === "task" ? "taskList" : kind === "ordered" ? "orderedList" : "bulletList";
  const attrs = kind === "task" ? { localId: null } : undefined;
  return {
    node:
      attrs === undefined
        ? { type: wrapperType, content: items }
        : { type: wrapperType, attrs, content: items },
    next: i,
  };
}

interface InlineToken {
  start: number;
  end: number;
  node: AdfNode;
}

function buildParagraph(text: string): AdfNode | null {
  const lines = text.split(/\r?\n/);
  const content: AdfNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const inline = buildInline(line);
    content.push(...inline);
    if (i < lines.length - 1) {
      content.push({ type: "hardBreak" });
    }
  }
  if (content.length === 0) {
    return null;
  }
  return { type: "paragraph", content };
}

function collectTokens(
  text: string,
  re: RegExp,
  make: (m: RegExpExecArray) => InlineToken,
): InlineToken[] {
  const out: InlineToken[] = [];
  const globalRe = new RegExp(re, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = globalRe.exec(text)) !== null) {
    out.push(make(match));
  }
  return out;
}

function markedText(text: string, mark: AdfMark): AdfNode {
  return { type: "text", text, marks: [mark] };
}

function buildInline(text: string): AdfNode[] {
  // Order matters: stronger/longer delimiters first so overlap filtering drops
  // the weaker match (e.g. `**bold**` beats the inner `*bold*`).
  const tokens: InlineToken[] = [
    ...collectTokens(text, INLINE_CODE_RE, (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      node: markedText(match[1] ?? "", { type: "code" }),
    })),
    ...collectTokens(text, STRONG_RE, (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      node: markedText(match[1] ?? match[2] ?? "", { type: "strong" }),
    })),
    ...collectTokens(text, STRIKE_RE, (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      node: markedText(match[1] ?? "", { type: "strike" }),
    })),
    ...collectTokens(text, LINK_RE, (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      node: markedText(match[1] ?? "", { type: "link", attrs: { href: match[2] ?? "" } }),
    })),
    ...collectTokens(text, EM_STAR_RE, (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      node: markedText(match[1] ?? "", { type: "em" }),
    })),
    ...collectTokens(text, EM_UNDER_RE, (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      node: markedText(match[1] ?? "", { type: "em" }),
    })),
    ...collectTokens(text, MENTION_RE, (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      node: { type: "mention", attrs: { id: match[1] } },
    })),
  ];
  tokens.sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    return b.end - b.start - (a.end - a.start);
  });
  const nonOverlapping: InlineToken[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start < cursor) {
      continue;
    }
    nonOverlapping.push(token);
    cursor = token.end;
  }
  const result: AdfNode[] = [];
  cursor = 0;
  for (const token of nonOverlapping) {
    if (token.start > cursor) {
      const plain = text.slice(cursor, token.start);
      if (plain.length > 0) {
        result.push({ type: "text", text: plain });
      }
    }
    result.push(token.node);
    cursor = token.end;
  }
  if (cursor < text.length) {
    const trailing = text.slice(cursor);
    if (trailing.length > 0) {
      result.push({ type: "text", text: trailing });
    }
  }
  return result;
}

/**
 * Walks an ADF document and emits a markdown approximation. Tolerates unknown
 * node types by falling back to concatenated `text` descendants.
 */
export function fromAdf(doc: AdfNode): string {
  const parts: string[] = [];
  for (const node of doc.content ?? []) {
    parts.push(renderBlock(node, 0));
  }
  return parts.join("\n\n").trim();
}

function renderBlock(node: AdfNode, depth: number): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content ?? []);
    case "heading": {
      const level = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
      const hashes = "#".repeat(Math.max(1, Math.min(6, level)));
      return `${hashes} ${renderInline(node.content ?? [])}`;
    }
    case "codeBlock": {
      const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      const text = (node.content ?? []).map((c) => c.text ?? "").join("");
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case "blockquote": {
      const inner = (node.content ?? []).map((c) => renderBlock(c, depth)).join("\n\n");
      return inner
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    }
    case "rule":
      return "---";
    case "bulletList":
      return renderList(node, "-", depth);
    case "orderedList":
      return renderList(node, "1.", depth);
    case "taskList":
      return renderTaskList(node, depth);
    default:
      return renderInline(node.content ?? []);
  }
}

function renderList(node: AdfNode, marker: string, depth: number): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  for (const item of node.content ?? []) {
    const children = item.content ?? [];
    const firstParagraph = children.find((c) => c.type === "paragraph");
    const head = firstParagraph === undefined ? "" : renderInline(firstParagraph.content ?? []);
    lines.push(`${indent}${marker} ${head}`);
    for (const child of children) {
      if (
        child.type === "bulletList" ||
        child.type === "orderedList" ||
        child.type === "taskList"
      ) {
        lines.push(renderBlock(child, depth + 1));
      }
    }
  }
  return lines.join("\n");
}

function renderTaskList(node: AdfNode, depth: number): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  for (const item of node.content ?? []) {
    const state = item.attrs?.state === "DONE" ? "x" : " ";
    const text = renderInline(item.content ?? []);
    lines.push(`${indent}- [${state}] ${text}`);
  }
  return lines.join("\n");
}

function renderInline(nodes: AdfNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    parts.push(renderInlineNode(node));
  }
  return parts.join("");
}

function renderInlineNode(node: AdfNode): string {
  switch (node.type) {
    case "text": {
      let text = node.text ?? "";
      const marks = node.marks ?? [];
      for (const mark of marks) {
        if (mark.type === "code") {
          text = `\`${text}\``;
        }
        if (mark.type === "strong") {
          text = `**${text}**`;
        }
        if (mark.type === "em") {
          text = `*${text}*`;
        }
        if (mark.type === "strike") {
          text = `~~${text}~~`;
        }
        if (mark.type === "link") {
          const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
          text = `[${text}](${href})`;
        }
      }
      return text;
    }
    case "hardBreak":
      return "\n";
    case "mention": {
      const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
      return `@accountId:${id}`;
    }
    default:
      return renderInline(node.content ?? []);
  }
}
