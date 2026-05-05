#!/usr/bin/env node
/**
 * Bundle the dashboard browser controller.
 *
 * src/dashboard/client/controller.ts (plus its imports) is written as a
 * regular TypeScript module against DOM types. esbuild bundles it into a
 * single IIFE at src/dashboard/assets/controller.js. The dashboard's
 * /assets/controller.js route serves it as a static asset — same pattern
 * as htmx.min.js. copy-assets.mjs later mirrors src/dashboard/assets to
 * dist/dashboard/assets during `npm run build`, so dev mode (reading from
 * src/) and built mode (reading from dist/) both work.
 *
 * We also type-check the client tree with tsc (via tsconfig.client.json)
 * before bundling, because esbuild strips types but does not enforce
 * them.
 */

import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const entry = resolve(repoRoot, "src/dashboard/client/controller.ts");
const outDir = resolve(repoRoot, "src/dashboard/assets");
const outFile = resolve(outDir, "controller.js");

mkdirSync(outDir, { recursive: true });

// Type-check the browser tree first. If tsc fails, bail before we emit
// a bundle — prevents a "green build, red browser" scenario.
console.log("build-client: type-checking src/dashboard/client");
execSync("npx tsc -p tsconfig.client.json --noEmit", { cwd: repoRoot, stdio: "inherit" });

console.log(`build-client: bundling ${entry} -> ${outFile}`);
await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
});
