import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { loadConfig, type RedQueenConfig } from "../core/config.js";
import { loadDotEnv } from "../core/env.js";
import { CliError } from "./errors.js";

const CONFIG_FILENAME = "redqueen.yaml";

export function findConfigUpward(startDir: string): string | null {
  let current = resolve(startDir);
  const root = parse(current).root;
  // Walk up until we find the config or hit the filesystem root.
  for (;;) {
    const candidate = join(current, CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    if (current === root) {
      return null;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function projectRootFromConfigPath(configPath: string): string {
  return dirname(resolve(configPath));
}

export interface LoadedProject {
  config: RedQueenConfig;
  configPath: string;
  configDir: string;
  projectRoot: string;
  envWarnings: string[];
}

/**
 * Locate redqueen.yaml, load the adjacent .env (so $VAR interpolation in YAML
 * resolves), then parse and validate the config. Every CLI command that reads
 * config must go through this helper so .env is always applied — otherwise
 * non-`start` commands silently bomb on missing env vars.
 */
export function loadConfigFromProject(startDir: string): LoadedProject {
  const configPath = findConfigUpward(startDir);
  if (configPath === null) {
    throw new CliError(`redqueen.yaml not found (searched from ${startDir} upward)`);
  }
  const configDir = dirname(configPath);
  const envResult = loadDotEnv(configDir);
  const config = loadConfig(configPath);
  return {
    config,
    configPath,
    configDir,
    projectRoot: projectRootFromConfigPath(configPath),
    envWarnings: envResult.warnings,
  };
}
