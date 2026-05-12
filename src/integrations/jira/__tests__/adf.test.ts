import { describe, it, expect } from "vitest";
import { fromAdf, toAdf } from "../adf.js";
import type { AdfNode } from "../adf.js";

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

  it("emits code blocks without language", () => {
    const doc = toAdf("```\nplain\n```");
    const code = doc.content?.[0];
    expect(code?.type).toBe("codeBlock");
    expect(code?.attrs?.language).toBeUndefined();
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

  it("emits headings with the correct level", () => {
    const doc = toAdf("# Title\n\n## Subtitle\n\n### Third");
    expect(doc.content?.[0]?.type).toBe("heading");
    expect(doc.content?.[0]?.attrs?.level).toBe(1);
    expect(doc.content?.[1]?.attrs?.level).toBe(2);
    expect(doc.content?.[2]?.attrs?.level).toBe(3);
  });

  it("folds inline marks inside heading text", () => {
    const doc = toAdf("## Use `npm run check`");
    const heading = doc.content?.[0];
    const code = heading?.content?.find((n) => n.marks?.some((m) => m.type === "code"));
    expect(code?.text).toBe("npm run check");
  });

  it("emits bulletList for dash bullets", () => {
    const doc = toAdf("- one\n- two");
    const list = doc.content?.[0];
    expect(list?.type).toBe("bulletList");
    expect(list?.content).toHaveLength(2);
    expect(list?.content?.[0]?.type).toBe("listItem");
  });

  it("emits orderedList for numbered items", () => {
    const doc = toAdf("1. first\n2. second");
    const list = doc.content?.[0];
    expect(list?.type).toBe("orderedList");
    expect(list?.content).toHaveLength(2);
  });

  it("emits taskList with TODO / DONE state", () => {
    const doc = toAdf("- [ ] pending\n- [x] done");
    const list = doc.content?.[0];
    expect(list?.type).toBe("taskList");
    expect(list?.content?.[0]?.type).toBe("taskItem");
    expect(list?.content?.[0]?.attrs?.state).toBe("TODO");
    expect(list?.content?.[1]?.attrs?.state).toBe("DONE");
  });

  it("assigns a string localId to taskList and taskItem", () => {
    const doc = toAdf("- [ ] pending");
    const list = doc.content?.[0];
    expect(typeof list?.attrs?.localId).toBe("string");
    expect((list?.attrs?.localId as string).length).toBeGreaterThan(0);
    expect(typeof list?.content?.[0]?.attrs?.localId).toBe("string");
  });

  it("preserves content after a task list as a sibling bullet list", () => {
    // ADF taskItem is inline-only, so indented bullets under a checkbox can't
    // become children. They should survive as a following block, not vanish.
    const doc = toAdf("- [ ] outer\n  - nested detail");
    expect(doc.content?.[0]?.type).toBe("taskList");
    const rendered = fromAdf(doc);
    expect(rendered).toContain("nested detail");
  });

  it("nests a bullet list inside a bullet list", () => {
    const doc = toAdf("- outer\n  - inner\n- back");
    const list = doc.content?.[0];
    const firstItem = list?.content?.[0];
    const nested = firstItem?.content?.find((n) => n.type === "bulletList");
    expect(nested).toBeDefined();
    expect(nested?.content?.[0]?.type).toBe("listItem");
  });

  it("emits blockquote", () => {
    const doc = toAdf("> quoted text");
    const quote = doc.content?.[0];
    expect(quote?.type).toBe("blockquote");
    expect(quote?.content?.[0]?.type).toBe("paragraph");
  });

  it("emits rule for ---", () => {
    const doc = toAdf("before\n\n---\n\nafter");
    expect(doc.content?.[1]?.type).toBe("rule");
  });

  it("recognizes bold with asterisks", () => {
    const doc = toAdf("This is **bold** text.");
    const para = doc.content?.[0];
    const strong = para?.content?.find((n) => n.marks?.some((m) => m.type === "strong"));
    expect(strong?.text).toBe("bold");
  });

  it("recognizes italic with asterisks", () => {
    const doc = toAdf("This is *emphasis*.");
    const para = doc.content?.[0];
    const em = para?.content?.find((n) => n.marks?.some((m) => m.type === "em"));
    expect(em?.text).toBe("emphasis");
  });

  it("recognizes strikethrough", () => {
    const doc = toAdf("~~gone~~");
    const para = doc.content?.[0];
    const strike = para?.content?.find((n) => n.marks?.some((m) => m.type === "strike"));
    expect(strike?.text).toBe("gone");
  });

  it("prefers strong over nested em when overlapping", () => {
    const doc = toAdf("**bold**");
    const para = doc.content?.[0];
    const marks = para?.content?.[0]?.marks ?? [];
    expect(marks[0]?.type).toBe("strong");
  });

  it("rescues Jira wiki monospace {{x}} as inline code", () => {
    // Skill prompts forbid wiki syntax, but LLMs leak it from training data.
    // The normalizer treats {{x}} as a wiki context indicator and rewrites
    // to backticks so Jira renders rich text instead of literal `{{x}}`.
    const doc = toAdf("The {{OnPostAsync}} method.");
    const para = doc.content?.[0];
    const code = para?.content?.find((n) => n.marks?.some((m) => m.type === "code"));
    expect(code?.text).toBe("OnPostAsync");
  });

  it("rescues Jira wiki headings (h2.) as markdown headings", () => {
    const doc = toAdf("h2. Problem\n\nBody text.");
    expect(doc.content?.[0]?.type).toBe("heading");
    expect(doc.content?.[0]?.attrs?.level).toBe(2);
  });

  it("rescues Jira wiki bold *X* when wiki context is present", () => {
    const doc = toAdf("h2. Title\n\nThe *In Progress* badge.");
    const para = doc.content?.[1];
    const strong = para?.content?.find((n) => n.marks?.some((m) => m.type === "strong"));
    expect(strong?.text).toBe("In Progress");
  });

  it("leaves *X* as italic when there is no wiki context", () => {
    // Pure markdown input — must not accidentally promote italic to bold.
    const doc = toAdf("Plain prose with *emphasis* here.");
    const para = doc.content?.[0];
    const em = para?.content?.find((n) => n.marks?.some((m) => m.type === "em"));
    expect(em?.text).toBe("emphasis");
  });

  it("does not touch existing **bold** when wiki context is present", () => {
    const doc = toAdf("h2. Title\n\nAlready **bold** here.");
    const para = doc.content?.[1];
    const strong = para?.content?.find((n) => n.marks?.some((m) => m.type === "strong"));
    expect(strong?.text).toBe("bold");
  });

  it("rescues {code:lang}…{code} blocks as fenced code", () => {
    const doc = toAdf("{code:ts}\nconst x = 1;\n{code}");
    const code = doc.content?.[0];
    expect(code?.type).toBe("codeBlock");
    expect(code?.attrs?.language).toBe("ts");
    expect(code?.content?.[0]?.text).toBe("const x = 1;");
  });

  it("rescues {noformat}…{noformat} blocks", () => {
    const doc = toAdf("{noformat}\nplain text\n{noformat}");
    const code = doc.content?.[0];
    expect(code?.type).toBe("codeBlock");
  });

  it("does not transform {{x}} inside backticked inline code", () => {
    // The literal text inside `…` must survive — toAdf treats inline code
    // bodies as raw, but the normalizer would otherwise rewrite {{x}}.
    const doc = toAdf("Use `{{template}}` literally and {{wiki}} as code.");
    const para = doc.content?.[0];
    const codes = (para?.content ?? []).filter((n) => n.marks?.some((m) => m.type === "code"));
    expect(codes.map((c) => c.text)).toEqual(["{{template}}", "wiki"]);
  });

  it("rescues Jira pipe-style links [text|url]", () => {
    const doc = toAdf("h2. Title\n\nSee [docs|https://example.com] for info.");
    const para = doc.content?.[1];
    const link = para?.content?.find((n) => n.marks?.some((m) => m.type === "link"));
    expect(link?.text).toBe("docs");
    expect(link?.marks?.[0]?.attrs?.href).toBe("https://example.com");
  });

  it("rescues bq. blockquotes", () => {
    const doc = toAdf("h2. Title\n\nbq. quoted line");
    expect(doc.content?.[1]?.type).toBe("blockquote");
  });

  it("rescues the realistic wiki-leaked spec from production", () => {
    // This is the exact pattern that broke in Jira: heading, monospace, and
    // wiki bold all mixed. Without the normalizer they showed as literal text.
    const input = [
      "h2. Problem",
      "",
      "In ({{Views/Reservations/Index.cshtml}}), when *In Progress*, the dropdown collapses.",
    ].join("\n");
    const doc = toAdf(input);
    expect(doc.content?.[0]?.type).toBe("heading");
    const para = doc.content?.[1];
    const codeMark = para?.content?.find((n) => n.marks?.some((m) => m.type === "code"));
    expect(codeMark?.text).toBe("Views/Reservations/Index.cshtml");
    const strongMark = para?.content?.find((n) => n.marks?.some((m) => m.type === "strong"));
    expect(strongMark?.text).toBe("In Progress");
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

  it("renders headings", () => {
    const out = fromAdf({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
      ],
    });
    expect(out).toBe("## Title");
  });

  it("renders bullet lists", () => {
    const out = fromAdf({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }],
            },
          ],
        },
      ],
    });
    expect(out).toBe("- one\n- two");
  });

  it("renders task lists with state", () => {
    const out = fromAdf({
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { state: "DONE" },
              content: [{ type: "text", text: "done" }],
            },
            {
              type: "taskItem",
              attrs: { state: "TODO" },
              content: [{ type: "text", text: "todo" }],
            },
          ],
        },
      ],
    });
    expect(out).toBe("- [x] done\n- [ ] todo");
  });

  it("renders blockquote", () => {
    const out = fromAdf({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }],
        },
      ],
    });
    expect(out).toBe("> quoted");
  });

  it("renders strong, em, strike marks", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a", marks: [{ type: "strong" }] },
            { type: "text", text: " " },
            { type: "text", text: "b", marks: [{ type: "em" }] },
            { type: "text", text: " " },
            { type: "text", text: "c", marks: [{ type: "strike" }] },
          ],
        },
      ],
    };
    expect(fromAdf(doc)).toBe("**a** *b* ~~c~~");
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
      "## Acceptance Criteria",
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
    expect(rendered).toContain("## Acceptance Criteria");
    expect(rendered).toContain("- Must compile without warnings.");
    expect(rendered).toContain("`npm run check`");
    expect(rendered).toContain("```ts");
    expect(rendered).toContain("[docs](https://example.com)");
  });

  it("preserves a realistic implementation spec", () => {
    const input = [
      "## Problem",
      "",
      "The `OnPostAsync` method never receives the annotated URL.",
      "",
      "## Files to Change",
      "",
      "- `Pages/Measurement.cshtml.cs` — remove dead handler",
      "- `Pages/Shared/ImageUpload.cshtml.cs` — add logging",
      "",
      "## Open Questions",
      "",
      "- [ ] Should we delete the unused field?",
      "- [x] Confirmed: no external callers.",
    ].join("\n");
    const adf = toAdf(input);
    const rendered = fromAdf(adf);
    expect(rendered).toContain("## Problem");
    expect(rendered).toContain("`OnPostAsync`");
    expect(rendered).toContain("- `Pages/Measurement.cshtml.cs` — remove dead handler");
    expect(rendered).toContain("- [ ] Should we delete the unused field?");
    expect(rendered).toContain("- [x] Confirmed: no external callers.");
  });
});
