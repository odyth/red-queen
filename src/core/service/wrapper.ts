import { chmodSync, writeFileSync } from "node:fs";

export interface WrapperScriptInput {
  envFilePath: string;
  redqueenBinPath: string;
  nodeBinPath: string;
}

/**
 * Single-quote escape for POSIX shell. Every embedded single quote becomes
 * `'\''` so the final value is always a single-quoted literal that cannot
 * be broken out of by user-controlled path contents (spaces, quotes, `$`).
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderWrapperScript(input: WrapperScriptInput): string {
  const envFile = shellSingleQuote(input.envFilePath);
  const bin = shellSingleQuote(input.redqueenBinPath);
  const node = shellSingleQuote(input.nodeBinPath);
  // Invoke node by absolute path so launchd / systemd-user don't depend on
  // the shell PATH (which doesn't include nvm-managed binaries by default).
  return [
    "#!/usr/bin/env bash",
    "set -e",
    "set -a",
    `. ${envFile}`,
    "set +a",
    `exec ${node} ${bin} start`,
    "",
  ].join("\n");
}

export function writeWrapperScript(path: string, input: WrapperScriptInput): void {
  writeFileSync(path, renderWrapperScript(input), "utf8");
  chmodSync(path, 0o755);
}
