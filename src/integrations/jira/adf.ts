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

/**
 * Converts markdown-ish plain text to ADF. Supports:
 * - Paragraphs (split on blank lines)
 * - Fenced code blocks (```lang\n…\n```)
 * - Inline code (`code`)
 * - Inline links ([text](url))
 * - Mentions (@accountId:<id>)
 * - Hard line breaks (\n inside a paragraph)
 */
export function toAdf(markdown: string): AdfDocument {
  const content: AdfNode[] = [];
  const blocks = splitBlocks(markdown);
  for (const block of blocks) {
    if (block.type === "code") {
      content.push({
        type: "codeBlock",
        attrs: block.language === null ? {} : { language: block.language },
        content: [{ type: "text", text: block.text }],
      });
      continue;
    }
    const paragraph = buildParagraph(block.text);
    if (paragraph !== null) {
      content.push(paragraph);
    }
  }
  if (content.length === 0) {
    content.push({ type: "paragraph", content: [] });
  }
  return { type: "doc", version: 1, content };
}

interface Block {
  type: "text" | "code";
  text: string;
  language: string | null;
}

function splitBlocks(input: string): Block[] {
  const lines = input.split(/\r?\n/);
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let inCode = false;
  let codeLang: string | null = null;
  let codeLines: string[] = [];

  const flushText = (): void => {
    if (buffer.length === 0) {
      return;
    }
    const text = buffer.join("\n").trim();
    if (text.length > 0) {
      blocks.push({ type: "text", text, language: null });
    }
    buffer = [];
  };

  for (const line of lines) {
    const fence = /^```(.*)$/.exec(line);
    if (fence !== null) {
      if (inCode) {
        blocks.push({ type: "code", text: codeLines.join("\n"), language: codeLang });
        codeLines = [];
        codeLang = null;
        inCode = false;
      } else {
        flushText();
        inCode = true;
        const lang = fence[1]?.trim() ?? "";
        codeLang = lang.length > 0 ? lang : null;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (line.trim().length === 0) {
      flushText();
      continue;
    }
    buffer.push(line);
  }
  if (inCode) {
    blocks.push({ type: "code", text: codeLines.join("\n"), language: codeLang });
  }
  flushText();
  return blocks;
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

function buildInline(text: string): AdfNode[] {
  const tokens: InlineToken[] = [
    ...collectTokens(text, MENTION_RE, (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      node: { type: "mention", attrs: { id: match[1] } },
    })),
    ...collectTokens(text, LINK_RE, (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      node: {
        type: "text",
        text: match[1] ?? "",
        marks: [{ type: "link", attrs: { href: match[2] ?? "" } }],
      },
    })),
    ...collectTokens(text, INLINE_CODE_RE, (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      node: {
        type: "text",
        text: match[1] ?? "",
        marks: [{ type: "code" }],
      },
    })),
  ];
  tokens.sort((a, b) => a.start - b.start);
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
 * Walks an ADF document and emits a plain-markdown approximation. Tolerates
 * unknown node types by falling back to concatenated `text` descendants.
 */
export function fromAdf(doc: AdfNode): string {
  const parts: string[] = [];
  for (const node of doc.content ?? []) {
    parts.push(renderNode(node));
  }
  return parts.join("\n\n").trim();
}

function renderNode(node: AdfNode): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content ?? []);
    case "codeBlock": {
      const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      const text = (node.content ?? []).map((c) => c.text ?? "").join("");
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    default:
      return renderInline(node.content ?? []);
  }
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
