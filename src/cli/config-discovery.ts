import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

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
