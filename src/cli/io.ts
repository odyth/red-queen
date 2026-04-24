import { CliError } from "./errors.js";

export async function readBodyFromStdinOrFlag(
  bodyFlag: string | undefined,
  fieldName = "body",
): Promise<string> {
  if (bodyFlag !== undefined) {
    return bodyFlag;
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
  if (process.stdin.isTTY === true) {
    throw new CliError(`${fieldName} required — pass --body "<text>" or pipe via stdin`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function writeJson(value: unknown, pretty = false): void {
  const out = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  process.stdout.write(`${out}\n`);
}

export function writeText(value: string): void {
  process.stdout.write(value);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
  if (value.length === 0 || value.endsWith("\n") === false) {
    process.stdout.write("\n");
  }
}
