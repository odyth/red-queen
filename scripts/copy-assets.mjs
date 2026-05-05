#!/usr/bin/env node
/**
 * Copy non-TypeScript assets from src/ to dist/ after compilation.
 *
 * Currently handles:
 *   src/skills/**    -> dist/skills/**
 *   src/templates/** -> dist/templates/**
 *
 * Runs as `npm run postbuild`. Fails non-zero if a target directory
 * ends up empty — that would silently break `redqueen init` / skill
 * resolution in the published package.
 */

import { cpSync, readdirSync, rmSync, statSync, existsSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const pairs = [
  { from: resolve(repoRoot, "src/skills"), to: resolve(repoRoot, "dist/skills") },
  { from: resolve(repoRoot, "src/templates"), to: resolve(repoRoot, "dist/templates") },
  { from: resolve(repoRoot, "src/dashboard/assets"), to: resolve(repoRoot, "dist/dashboard/assets") },
];

for (const { from, to } of pairs) {
  if (existsSync(from) === false) {
    console.error(`copy-assets: source directory missing: ${from}`);
    process.exit(1);
  }
  cpSync(from, to, {
    recursive: true,
    force: true,
    filter: (src) => src.includes(`/__tests__`) === false,
  });

  // cpSync filter applies per-path, but prune any stale __tests__ that slipped
  // in from a prior non-filtered run just to be safe.
  pruneTests(to);

  const contents = readdirSync(to);
  if (contents.length === 0) {
    console.error(`copy-assets: target empty after copy: ${to}`);
    process.exit(1);
  }
  console.log(`copy-assets: ${from} -> ${to} (${contents.length} top-level entries)`);
}

function pruneTests(root) {
  if (existsSync(root) === false) return;
  for (const entry of readdirSync(root)) {
    const full = resolve(root, entry);
    if (entry === "__tests__") {
      rmSync(full, { recursive: true, force: true });
      continue;
    }
    try {
      if (statSync(full).isDirectory()) {
        pruneTests(full);
      }
    } catch {
      // ignore
    }
  }
}

// Make the compiled CLI entry point executable so `npx redqueen` works out
// of the box — tsc drops the shebang's execute bit on emit.
const cliEntry = resolve(repoRoot, "dist/cli/index.js");
if (existsSync(cliEntry)) {
  try {
    chmodSync(cliEntry, 0o755);
  } catch (err) {
    console.error(`copy-assets: chmod ${cliEntry} failed: ${String(err)}`);
    // non-fatal — most install paths handle this via the bin field
  }
}

// Sanity check: at least one SKILL.md must be present.
const skillFiles = listSkillFiles(resolve(repoRoot, "dist/skills"));
if (skillFiles.length === 0) {
  console.error("copy-assets: no SKILL.md files ended up in dist/skills");
  process.exit(1);
}
console.log(`copy-assets: ${skillFiles.length} SKILL.md files shipped.`);

function listSkillFiles(dir) {
  if (existsSync(dir) === false) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      const candidate = resolve(full, "SKILL.md");
      if (existsSync(candidate)) {
        out.push(candidate);
      }
    }
  }
  return out;
}
