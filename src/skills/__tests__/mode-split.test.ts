import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceSkillName } from "../../core/skill-context.js";

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(here, "..");

const BASE_SKILLS = ["prompt-writer", "coder", "reviewer", "tester", "comment-handler"];

// A worker must only ever read instructions for the mode it runs in. Prompts
// that describe both modes make it pick a branch at every step, and it drifts.
const SINGLE_REPO_PROHIBITED = [
  /workspace/i,
  /\brepos\b/,
  /--repos?\b/,
  /inScope/,
  /mergeCompleted/,
];
const WORKSPACE_PROHIBITED = [
  /workspace mode/i,
  /legacy/i,
  /single-repo/i,
  /`repos` (is )?(present|absent)/i,
];

function readSkill(name: string): string {
  return readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
}

function expectNone(content: string, patterns: RegExp[], name: string): void {
  for (const pattern of patterns) {
    const match = pattern.exec(content);
    expect(
      match,
      `Prohibited pattern ${pattern.toString()} found in ${name}: "${match?.[0] ?? ""}"`,
    ).toBeNull();
  }
}

describe("default skills are written for one mode each", () => {
  for (const base of BASE_SKILLS) {
    const variant = workspaceSkillName(base);

    it(`${base}: carries no workspace instructions`, () => {
      expectNone(readSkill(base), SINGLE_REPO_PROHIBITED, base);
    });

    it(`${variant}: carries no single-repo or mode-selection instructions`, () => {
      expectNone(readSkill(variant), WORKSPACE_PROHIBITED, variant);
    });

    it(`${variant}: works from repos[] and passes --repo`, () => {
      const content = readSkill(variant);
      expect(content).toContain("`repos`");
      expect(content).toMatch(/--repos? /);
    });

    for (const name of [base, variant]) {
      it(`${name}: frontmatter name matches its directory`, () => {
        expect(readSkill(name)).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
      });
    }
  }
});
