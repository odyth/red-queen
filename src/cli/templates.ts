import { readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TemplateKind = "spec-template" | "coding-standards" | "review-checklist";

export function resolveTemplatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev: src/cli/templates.ts -> ../templates
  // Built: dist/cli/templates.js -> ../templates (after postbuild copies src/templates -> dist/templates)
  return resolve(here, "..", "templates");
}

export function listTemplates(kind: TemplateKind): string[] {
  const dir = join(resolveTemplatesDir(), "references", kind);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
  if (existsSync(dir) === false) {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

export function templatePath(kind: TemplateKind, choice: string): string {
  return join(resolveTemplatesDir(), "references", kind, `${choice}.md`);
}

export function resolveSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "skills");
}
