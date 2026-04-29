import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function resolvePackageJsonPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "package.json");
}

interface PackageJson {
  version: string;
}

function loadPackageJson(): PackageJson {
  const raw = readFileSync(resolvePackageJsonPath(), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    typeof (parsed as { version: unknown }).version === "string"
  ) {
    return parsed as PackageJson;
  }
  throw new Error("package.json has no string 'version' field");
}

let cached: string | null = null;

export function packageVersion(): string {
  cached ??= loadPackageJson().version;
  return cached;
}

export function userAgent(): string {
  return `red-queen/${packageVersion()}`;
}
