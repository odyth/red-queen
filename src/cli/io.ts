import { CliError } from "./errors.js";

export async function readBodyFromStdinOrFlag(
  bodyFlag: string | undefined,
  fieldName = "body",
): Promise<string> {
  if (bodyFlag !== undefined) {
    if (bodyFlag.trim() === "") {
      throw new CliError(`${fieldName} must not be empty`);
    }
    return bodyFlag;
  }
  if (process.stdin.isTTY === true) {
    throw new CliError(`${fieldName} required — pass --body "<text>" or pipe via stdin`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  // An empty/whitespace body renders as a bare "-" in Jira (toAdf produces an empty
  // doc). Reject it so a skill that runs `issue comment` with no body fails loudly
  // instead of silently posting a blank comment in place of its real reason.
  if (body.trim() === "") {
    throw new CliError(
      `${fieldName} must not be empty — pass --body "<text>" or pipe non-empty content via stdin`,
    );
  }
  return body;
}

export function writeJson(value: unknown, pretty = false): void {
  const out = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  process.stdout.write(`${out}\n`);
}

export function writeText(value: string): void {
  process.stdout.write(value);
  if (value.length === 0 || value.endsWith("\n") === false) {
    process.stdout.write("\n");
  }
}
