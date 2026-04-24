import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MAX_WALK_LEVELS = 3;

export interface LoadDotEnvResult {
  path: string | null;
  loaded: string[];
  warnings: string[];
}

/**
 * Walks up from startDir looking for a `.env` file. Loads the first one found
 * into process.env using the `??=` pattern — shell env vars win over file values.
 */
export function loadDotEnv(startDir: string, maxLevels = MAX_WALK_LEVELS): LoadDotEnvResult {
  const resolved = resolve(startDir);
  let current = resolved;
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) {
      return applyDotEnv(candidate);
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return { path: null, loaded: [], warnings: [] };
}

function applyDotEnv(path: string): LoadDotEnvResult {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  const loaded: string[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const parsed = parseLine(trimmed);
    if (parsed === null) {
      warnings.push(`.env:${String(i + 1)}: could not parse line — skipped`);
      continue;
    }
    const { key, value } = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }

  return { path, loaded, warnings };
}

function parseLine(line: string): { key: string; value: string } | null {
  const eqIndex = line.indexOf("=");
  if (eqIndex <= 0) {
    return null;
  }
  const rawKey = line.slice(0, eqIndex).trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawKey) === false) {
    return null;
  }
  let rawValue = line.slice(eqIndex + 1).trim();
  if (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) {
    rawValue = rawValue.slice(1, -1);
  } else if (rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length >= 2) {
    rawValue = rawValue.slice(1, -1);
  }
  return { key: rawKey, value: rawValue };
}
