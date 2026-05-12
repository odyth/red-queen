import { randomUUID } from "node:crypto";

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
const FENCE_CLOSE_RE = /^```\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^>\s?(.*)$/;
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)\d+\.\s+(.*)$/;
const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const LEADING_WS_RE = /^\s*/;

type ListKind = "bullet" | "ordered" | "task";

/**
 * Converts markdown to ADF. Supports:
 * - Headings (#..######)
 * - Paragraphs (split on blank lines)
 * - Fenced code blocks (```lang\n…\n```)
 * - Blockquotes (> line)
 * - Bullet and ordered lists (one level of nesting); task lists (flat — taskItem is inline-only per ADF)
 * - Horizontal rules (--- / *** / ___)
 * - Inline code (`code`)
 * - Bold (**text** / __text__), italic (*text* / _text_), strikethrough (~~text~~)
 * - Inline links ([text](url))
 * - Mentions (@accountId:<id>)
 * - Hard line breaks (\n inside a paragraph)
 * - Inline code or mentions nested inside strong/em/strike/link (the code/mention
 *   leaf and the outer mark stack on the same text node). Mentions inside a
 *   container drop the parent mark because ADF mention nodes don't carry text
 *   marks.
 *
 * Deliberately NOT supported: other mark-in-mark combinations (bold-in-italic,
 * link-in-bold) still flatten to the outer mark. Setext headings, HTML
 * passthrough, reference-style links, and tables are also unsupported.
 */
export function toAdf(markdown: string): AdfDocument {
  const normalized = normalizeWikiToMarkdown(markdown);
  const lines = normalized.split(/\r?\n/);
  const content = parseBlocks(lines, 0, lines.length);
  if (content.length === 0) {
    content.push({ type: "paragraph", content: [] });
  }
  return { type: "doc", version: 1, content };
}

const WIKI_HEADING_RE = /^h[1-6]\.\s+\S/m;
const WIKI_BLOCKQUOTE_LINE_RE = /^bq\.\s+\S/m;
const WIKI_BLOCK_OPENER_RE = /\{(?:code|noformat|quote)(?:[:}|\s])/;

/**
 * Normalizes Jira wiki-style tokens (h2., {{x}}, *bold*, {code}, bq., [t|u]) to
 * their markdown equivalents so toAdf can render them as rich text. Skill
 * prompts forbid wiki syntax but LLM training data leaks it constantly — this
 * runs as a safety net so the spec/comment field doesn't show literal `h2.` and
 * `{{...}}` in Jira.
 *
 * Conservative by design: only activates on a strong wiki indicator (h\d.,
 * bq., {code}/{noformat}/{quote}). Weak indicators like {{x}} and [t|u] are
 * genuinely ambiguous with template syntax (Vue/Mustache/Jinja/Handlebars) and
 * grammar/config docs, so they don't activate on their own. This avoids
 * silently promoting *italic* to **bold** in template-heavy specs.
 */
function normalizeWikiToMarkdown(input: string): string {
  if (hasWikiContext(input) === false) {
    return input;
  }

  // Per-call nonce so a literal `_PRES_<n>_` in the input can't collide with
  // our stash slot. A deterministic placeholder would silently rewrite user
  // content to whatever lives at that index; the nonce makes that statistically
  // impossible.
  const nonce = randomUUID().replace(/-/g, "").slice(0, 12);
  const stashTag = `__RQNS_${nonce}_`;
  const placeholderRe = new RegExp(`${stashTag}(\\d+)_`, "g");

  const preserved: string[] = [];
  const stash = (chunk: string): string => {
    preserved.push(chunk);
    return `${stashTag}${String(preserved.length - 1)}_`;
  };

  let out = input;

  // Stash markdown fences first — LLMs sometimes mix syntaxes in one doc.
  out = out.replace(/```[\s\S]*?```/g, stash);

  // Convert {code:lang}...{code} and {noformat}...{noformat} to fenced
  // markdown and stash so later inline transforms don't touch their bodies.
  out = out.replace(
    /\{code(?::([^}]*))?\}([\s\S]*?)\{code\}/g,
    (_match, lang: string | undefined, body: string) => {
      const cleaned = body.replace(/^\n|\n$/g, "");
      const langPart = lang ?? "";
      return stash(`\`\`\`${langPart}\n${cleaned}\n\`\`\``);
    },
  );
  out = out.replace(/\{noformat\}([\s\S]*?)\{noformat\}/g, (_match, body: string) => {
    const cleaned = body.replace(/^\n|\n$/g, "");
    return stash(`\`\`\`\n${cleaned}\n\`\`\``);
  });

  // Stash inline markdown code too, so {{x}} inside backticks stays literal.
  out = out.replace(/`[^`\n]+`/g, stash);

  // Convert {{x}} to inline code, then re-stash those new backtick spans
  // before the wiki-bold pass below. Without this, `{{*foo*}}` would become
  // `*foo*`, then get bolded to `**foo**`, then parse as inline code
  // containing literal **foo** — the asterisks would leak into the code span.
  out = out.replace(/\{\{([^}\n]+)\}\}/g, "`$1`");
  out = out.replace(/`[^`\n]+`/g, stash);

  out = out.replace(/\[([^\]\n|]+)\|([^\]\n]+)\]/g, "[$1]($2)");
  // Wiki single-asterisk bold → markdown double-asterisk bold. Lookarounds
  // enforce word boundaries: not preceded by alphanumeric/`*`/`\` and not
  // followed by alphanumeric/`*`. Keeps `a*X*b` (no boundary), embedded
  // asterisks (`file*.txt`), and existing `**bold**` from being rewritten.
  out = out.replace(/(?<![A-Za-z0-9*\\])\*([^*\n]+?)\*(?![A-Za-z0-9*])/g, "**$1**");

  // Block-level wiki tokens.
  out = out.replace(/^h([1-6])\.\s+(.+)$/gm, (_match, level: string, text: string) => {
    return `${"#".repeat(Number(level))} ${text}`;
  });
  out = out.replace(/^bq\.\s+(.+)$/gm, "> $1");
  out = out.replace(/\{quote\}([\s\S]*?)\{quote\}/g, (_match, body: string) => {
    return body
      .split("\n")
      .map((line) => (line.trim().length > 0 ? `> ${line}` : ">"))
      .join("\n");
  });

  out = out.replace(placeholderRe, (_match, idx: string) => preserved[Number(idx)] ?? "");
  return out;
}

function hasWikiContext(input: string): boolean {
  // Strong indicators only — these tokens don't appear in normal markdown or
  // technical text, so any one of them is enough to activate the normalizer.
  // Weak indicators ({{x}}, [t|u]) are deliberately excluded: they're
  // ambiguous with templates and grammar notation, and activating on them
  // alone would silently change italic→bold in template-heavy specs.
  if (WIKI_HEADING_RE.test(input)) {
    return true;
  }
  if (WIKI_BLOCKQUOTE_LINE_RE.test(input)) {
    return true;
  }
  if (WIKI_BLOCK_OPENER_RE.test(input)) {
    return true;
  }
  return false;
}

function parseBlocks(lines: string[], start: number, end: number): AdfNode[] {
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
        if (FENCE_CLOSE_RE.test(next)) {
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

    const listKind = detectListKind(line, 0);
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
      if (isBlockStart(candidate)) {
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

function isBlockStart(line: string): boolean {
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
  return detectListKind(line, 0) !== null;
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

    // A blank line between items doesn't end the list as long as another
    // item at this indent follows (loose lists). Without this, each item
    // becomes its own single-item list, and Atlassian's ADF→wiki converter
    // emits `# foo\n\n# bar`, which the wiki renderer parses as two
    // separate lists — every number renders as "1.".
    if (line.trim().length === 0) {
      let lookahead = i + 1;
      while (lookahead < end && (lines[lookahead] ?? "").trim().length === 0) {
        lookahead++;
      }
      if (lookahead >= end) {
        break;
      }
      if (matchListItem(lines[lookahead] ?? "", kind, indent) === null) {
        break;
      }
      i = lookahead;
      continue;
    }

    const item = matchListItem(line, kind, indent);
    if (item === null) {
      break;
    }
    i++;

    if (kind === "task") {
      // ADF taskItem accepts inline content only — no nested lists or paragraphs.
      // Don't peek for a nested block: we'd have to consume it and then throw
      // it away. Leaving those lines for parseBlocks preserves the content.
      items.push({
        type: "taskItem",
        attrs: { state: item.state ?? "TODO", localId: randomUUID() },
        content: buildInline(item.text),
      });
      continue;
    }

    // Collect continuation lines — indented text that belongs to this list
    // item. We fold them into the same paragraph (joined with hardBreaks)
    // instead of emitting separate paragraph children, because Atlassian's
    // ADF→wiki converter inserts blank lines between paragraph siblings,
    // which the wiki parser then sees as a list break.
    const segments: string[] = [item.text];
    while (i < end) {
      const next = lines[i] ?? "";
      if (next.trim().length === 0) {
        let peek = i + 1;
        while (peek < end && (lines[peek] ?? "").trim().length === 0) {
          peek++;
        }
        if (peek >= end) {
          break;
        }
        const peekLine = lines[peek] ?? "";
        const peekIndent = LEADING_WS_RE.exec(peekLine)?.[0].length ?? 0;
        if (peekIndent <= indent) {
          break;
        }
        const nestedKind = detectListKind(peekLine, indent + 1);
        if (nestedKind !== null && nestedKind.indent > indent) {
          break;
        }
        // Indented non-list content after blank lines is still part of this
        // item. Consume the blanks and keep scanning.
        i = peek;
        continue;
      }
      const nextIndent = LEADING_WS_RE.exec(next)?.[0].length ?? 0;
      if (nextIndent <= indent) {
        break;
      }
      const nestedKind = detectListKind(next, indent + 1);
      if (nestedKind !== null && nestedKind.indent > indent) {
        break;
      }
      segments.push(next.replace(/^\s+/, ""));
      i++;
    }

    const itemContent: AdfNode[] = [
      { type: "paragraph", content: buildInlineWithBreaks(segments.join("\n")) },
    ];

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

    items.push({ type: "listItem", content: itemContent });
  }

  if (kind === "task") {
    return {
      node: { type: "taskList", attrs: { localId: randomUUID() }, content: items },
      next: i,
    };
  }
  const wrapperType = kind === "ordered" ? "orderedList" : "bulletList";
  return { node: { type: wrapperType, content: items }, next: i };
}

interface InlineToken {
  start: number;
  end: number;
  node: AdfNode;
}

function buildParagraph(text: string): AdfNode | null {
  const content = buildInlineWithBreaks(text);
  if (content.length === 0) {
    return null;
  }
  return { type: "paragraph", content };
}

function buildInlineWithBreaks(text: string): AdfNode[] {
  const lines = text.split(/\r?\n/);
  const content: AdfNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    content.push(...buildInline(lines[i] ?? ""));
    if (i < lines.length - 1) {
      content.push({ type: "hardBreak" });
    }
  }
  return content;
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

interface OuterToken {
  start: number;
  end: number;
  // Containers (strong/em/strike/link) recurse into their inner text to pick
  // up nested code/mention leaves with the container's mark stacked on. Leaves
  // (code/mention outside any container) emit directly.
  container?: { innerText: string; mark: AdfMark };
  leaf?: AdfNode;
}

function buildInline(text: string): AdfNode[] {
  // Collect containers and leaves at the same level. Overlap rejection by
  // earliest-start-then-longest then decides who wins. When a container is
  // kept, recurse into its captured inner text for nested code/mention so
  // `**\`code\`**` becomes a single text node with marks [code, strong]
  // instead of strong with literal backticks. A leaf that starts before the
  // container wins (correctly preserving inline code that wraps stray `*`s).
  const tokens: OuterToken[] = [];

  pushContainerToken(text, STRONG_RE, tokens, (m) => ({
    innerText: m[1] ?? m[2] ?? "",
    mark: { type: "strong" },
  }));
  pushContainerToken(text, STRIKE_RE, tokens, (m) => ({
    innerText: m[1] ?? "",
    mark: { type: "strike" },
  }));
  pushContainerToken(text, LINK_RE, tokens, (m) => ({
    innerText: m[1] ?? "",
    mark: { type: "link", attrs: { href: m[2] ?? "" } },
  }));
  pushContainerToken(text, EM_STAR_RE, tokens, (m) => ({
    innerText: m[1] ?? "",
    mark: { type: "em" },
  }));
  pushContainerToken(text, EM_UNDER_RE, tokens, (m) => ({
    innerText: m[1] ?? "",
    mark: { type: "em" },
  }));
  pushLeafToken(text, INLINE_CODE_RE, tokens, (m) => ({
    type: "text",
    text: m[1] ?? "",
    marks: [{ type: "code" }],
  }));
  pushLeafToken(text, MENTION_RE, tokens, (m) => ({
    type: "mention",
    attrs: { id: m[1] },
  }));

  tokens.sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    return b.end - b.start - (a.end - a.start);
  });

  const nonOverlapping: OuterToken[] = [];
  let cursor = 0;
  for (const t of tokens) {
    if (t.start < cursor) {
      continue;
    }
    nonOverlapping.push(t);
    cursor = t.end;
  }

  const result: AdfNode[] = [];
  cursor = 0;
  for (const t of nonOverlapping) {
    if (t.start > cursor) {
      const plain = text.slice(cursor, t.start);
      if (plain.length > 0) {
        result.push({ type: "text", text: plain });
      }
    }
    if (t.container !== undefined) {
      result.push(...emitLeafs(t.container.innerText, [t.container.mark]));
    } else if (t.leaf !== undefined) {
      result.push(t.leaf);
    }
    cursor = t.end;
  }
  if (cursor < text.length) {
    const trailing = text.slice(cursor);
    if (trailing.length > 0) {
      result.push({ type: "text", text: trailing });
    }
  }
  return result;
}

function pushContainerToken(
  text: string,
  re: RegExp,
  out: OuterToken[],
  build: (m: RegExpExecArray) => { innerText: string; mark: AdfMark },
): void {
  const globalRe = new RegExp(re, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = globalRe.exec(text)) !== null) {
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      container: build(match),
    });
  }
}

function pushLeafToken(
  text: string,
  re: RegExp,
  out: OuterToken[],
  build: (m: RegExpExecArray) => AdfNode,
): void {
  const globalRe = new RegExp(re, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = globalRe.exec(text)) !== null) {
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      leaf: build(match),
    });
  }
}

// Emit the leaf-level pass over `text`: inline code and mentions. Both are
// leaves (no further inline marks can nest inside them), and any plain regions
// between them inherit `parentMarks` from the surrounding container.
function emitLeafs(text: string, parentMarks: AdfMark[]): AdfNode[] {
  interface Leaf {
    start: number;
    end: number;
    node: AdfNode;
  }
  const leaves: Leaf[] = [
    ...collectTokens(text, INLINE_CODE_RE, (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      node: {
        type: "text",
        text: match[1] ?? "",
        marks: [{ type: "code" }, ...parentMarks],
      },
    })),
    ...collectTokens(text, MENTION_RE, (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      // Mentions are their own node type and don't carry text marks in ADF;
      // dropping parentMarks here matches Atlassian's schema.
      node: { type: "mention", attrs: { id: match[1] } },
    })),
  ];
  leaves.sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    return b.end - b.start - (a.end - a.start);
  });

  const nonOverlapping: Leaf[] = [];
  let cursor = 0;
  for (const leaf of leaves) {
    if (leaf.start < cursor) {
      continue;
    }
    nonOverlapping.push(leaf);
    cursor = leaf.end;
  }

  const result: AdfNode[] = [];
  cursor = 0;
  const wrap = (plain: string): AdfNode => {
    return parentMarks.length === 0
      ? { type: "text", text: plain }
      : { type: "text", text: plain, marks: parentMarks };
  };
  for (const leaf of nonOverlapping) {
    if (leaf.start > cursor) {
      const plain = text.slice(cursor, leaf.start);
      if (plain.length > 0) {
        result.push(wrap(plain));
      }
    }
    result.push(leaf.node);
    cursor = leaf.end;
  }
  if (cursor < text.length) {
    const trailing = text.slice(cursor);
    if (trailing.length > 0) {
      result.push(wrap(trailing));
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
