import { describe, it, expect } from "vitest";
import { fromAdf, toAdf } from "../adf.js";

describe("toAdf", () => {
  it("creates a doc with an empty paragraph for empty input", () => {
    const doc = toAdf("");
    expect(doc.type).toBe("doc");
    expect(doc.content?.[0]?.type).toBe("paragraph");
  });

  it("creates a paragraph for a simple line", () => {
    const doc = toAdf("Hello, world.");
    const para = doc.content?.[0];
    expect(para?.type).toBe("paragraph");
    expect(para?.content?.[0]?.text).toBe("Hello, world.");
  });

  it("splits paragraphs on blank lines", () => {
    const doc = toAdf("First.\n\nSecond.");
    expect(doc.content).toHaveLength(2);
  });

  it("emits code blocks with language", () => {
    const doc = toAdf("```ts\nconst x = 1;\n```");
    const code = doc.content?.[0];
    expect(code?.type).toBe("codeBlock");
    expect(code?.attrs?.language).toBe("ts");
    expect(code?.content?.[0]?.text).toBe("const x = 1;");
  });

  it("recognizes inline code", () => {
    const doc = toAdf("Use `let` instead.");
    const para = doc.content?.[0];
    const code = para?.content?.find((n) => n.marks?.some((m) => m.type === "code"));
    expect(code?.text).toBe("let");
  });

  it("recognizes links", () => {
    const doc = toAdf("See [docs](https://example.com).");
    const para = doc.content?.[0];
    const link = para?.content?.find((n) => n.marks?.some((m) => m.type === "link"));
    expect(link?.text).toBe("docs");
    expect(link?.marks?.[0]?.attrs?.href).toBe("https://example.com");
  });

  it("recognizes mentions", () => {
    const doc = toAdf("Hi @accountId:712020:abc, fix this.");
    const para = doc.content?.[0];
    const mention = para?.content?.find((n) => n.type === "mention");
    expect(mention?.attrs?.id).toBe("712020:abc");
  });

  it("emits hard breaks for newlines within a paragraph", () => {
    const doc = toAdf("Line one\nLine two");
    const para = doc.content?.[0];
    const hb = para?.content?.find((n) => n.type === "hardBreak");
    expect(hb).toBeDefined();
  });
});

describe("fromAdf", () => {
  it("renders a paragraph", () => {
    const out = fromAdf({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
    });
    expect(out).toBe("Hello");
  });

  it("renders a code block", () => {
    const out = fromAdf({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    });
    expect(out).toBe("```ts\nconst x = 1;\n```");
  });

  it("renders inline code marks", () => {
    const out = fromAdf({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Use " },
            { type: "text", text: "let", marks: [{ type: "code" }] },
          ],
        },
      ],
    });
    expect(out).toBe("Use `let`");
  });

  it("renders links", () => {
    const out = fromAdf({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "docs",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
      ],
    });
    expect(out).toBe("[docs](https://example.com)");
  });

  it("renders mentions", () => {
    const out = fromAdf({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: "712020:abc" } }],
        },
      ],
    });
    expect(out).toBe("@accountId:712020:abc");
  });

  it("tolerates unknown nodes by concatenating text descendants", () => {
    const out = fromAdf({
      type: "doc",
      content: [
        {
          type: "funky",
          content: [{ type: "text", text: "hi" }],
        },
      ],
    });
    expect(out).toBe("hi");
  });
});

describe("round-trip", () => {
  it("preserves a spec-style body", () => {
    const input = [
      "Acceptance Criteria",
      "",
      "- Must compile without warnings.",
      "- Use `npm run check`.",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "See [docs](https://example.com) for details.",
    ].join("\n");
    const adf = toAdf(input);
    const rendered = fromAdf(adf);
    expect(rendered).toContain("Acceptance Criteria");
    expect(rendered).toContain("`npm run check`");
    expect(rendered).toContain("```ts");
    expect(rendered).toContain("[docs](https://example.com)");
  });
});
