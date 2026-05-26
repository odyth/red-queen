import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(here, "..");

// Patterns that leak tracker-specific detail. Skills must stay neutral —
// adapter swaps happen in config, not in skill text.
const PROHIBITED = [
  /mcp__atlassian/i,
  /customfield_/i,
  /\bgh pr\b/,
  /\bgh api\b/,
  /\bgh repo\b/,
  /\bgh issue\b/,
  /atlassian\.net/i,
  /\balignsmart\b/i,
  /jira\.cloudId/i,
  /users\.human\.accountId/i,
  /10054|10055|10056|10057|10058|10059|10061/, // AlignSmart AI-phase IDs
  /accountId/i,
];

function listSkillFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      const skill = join(full, "SKILL.md");
      try {
        statSync(skill);
        out.push(skill);
      } catch {
        // ignore — not every directory is a skill
      }
    }
  }
  return out;
}

describe("default skills are tracker-neutral", () => {
  const files = listSkillFiles(skillsDir);

  it("finds at least one skill file", () => {
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  for (const file of files) {
    it(`${file.split("/skills/").at(-1) ?? file}: contains no prohibited strings`, () => {
      const content = readFileSync(file, "utf8");
      for (const pattern of PROHIBITED) {
        const match = pattern.exec(content);
        expect(
          match,
          `Prohibited pattern ${pattern.toString()} found in ${file}: "${match?.[0] ?? ""}"`,
        ).toBeNull();
      }
    });
  }

  it("ships exactly the five default skills (+ README)", () => {
    const names = files.map((f) => f.split("/").at(-2));
    expect(new Set(names)).toEqual(
      new Set(["prompt-writer", "coder", "reviewer", "tester", "comment-handler"]),
    );
  });
});
