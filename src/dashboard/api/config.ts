import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseConfig } from "../../core/config.js";
import type { RedQueenConfig } from "../../core/config.js";
import type { RuntimeState } from "../../core/runtime-state.js";

export interface ConfigApiDeps {
  configPath: string;
  runtime: RuntimeState;
  reload: (newConfig: RedQueenConfig) => { applied: string[]; restartRequired: string[] };
}

const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const SENSITIVE_KEY_RE = /(TOKEN|SECRET|PASSWORD|PAT|PRIVATE_KEY)$/i;
const MIN_SECRET_LEN = 8;
const MAX_BODY_BYTES = 1 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", rejectPromise);
  });
}

function collectEnvRefs(yaml: string): { name: string; set: boolean }[] {
  const names = new Set<string>();
  for (const match of yaml.matchAll(ENV_VAR_RE)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return [...names].sort().map((name) => ({ name, set: process.env[name] !== undefined }));
}

export function buildBlockedValues(existingYaml: string): Map<string, string> {
  const blocked = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || value.length < MIN_SECRET_LEN) {
      continue;
    }
    if (SENSITIVE_KEY_RE.test(key)) {
      blocked.set(key, value);
    }
  }
  for (const match of existingYaml.matchAll(ENV_VAR_RE)) {
    const name = match[1];
    if (name === undefined) {
      continue;
    }
    const value = process.env[name];
    if (value !== undefined && value.length >= MIN_SECRET_LEN) {
      blocked.set(name, value);
    }
  }
  return blocked;
}

export function findSecretLeak(submitted: string, blocked: Map<string, string>): string | null {
  for (const [name, value] of blocked.entries()) {
    if (submitted.includes(value)) {
      return name;
    }
  }
  return null;
}

export function handleConfigGet(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ConfigApiDeps,
): void {
  let yaml: string;
  try {
    yaml = readFileSync(deps.configPath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: `could not read config: ${message}` });
    return;
  }
  sendJson(res, 200, { yaml, envRefs: collectEnvRefs(yaml) });
}

interface ValidationOutcome {
  ok: boolean;
  errors: string[];
  warnings: string[];
  config: RedQueenConfig | null;
}

function validateSubmittedYaml(yamlText: string): ValidationOutcome {
  try {
    const config = parseConfig(yamlText);
    return { ok: true, errors: [], warnings: [], config };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [message], warnings: [], config: null };
  }
}

export async function handleConfigValidate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendText(res, 413, "Payload Too Large");
    return;
  }
  const outcome = validateSubmittedYaml(body);
  sendJson(res, 200, { ok: outcome.ok, errors: outcome.errors, warnings: outcome.warnings });
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8" });
  renameSync(tmp, path);
}

export async function handleConfigPut(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConfigApiDeps,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendText(res, 413, "Payload Too Large");
    return;
  }

  const outcome = validateSubmittedYaml(body);
  if (outcome.ok === false || outcome.config === null) {
    sendJson(res, 400, { ok: false, errors: outcome.errors, warnings: outcome.warnings });
    return;
  }

  let existingYaml: string;
  try {
    existingYaml = readFileSync(deps.configPath, "utf8");
  } catch {
    existingYaml = "";
  }
  const blocked = buildBlockedValues(existingYaml);
  const leakedName = findSecretLeak(body, blocked);
  if (leakedName !== null) {
    sendJson(res, 400, {
      ok: false,
      errors: [`literal value of \${${leakedName}} detected; use \${${leakedName}} instead`],
      warnings: [],
    });
    return;
  }

  try {
    writeAtomic(deps.configPath, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, errors: [`write failed: ${message}`], warnings: [] });
    return;
  }

  let result: { applied: string[]; restartRequired: string[] };
  try {
    result = deps.reload(outcome.config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, errors: [`reload failed: ${message}`], warnings: [] });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    applied: result.applied,
    restartRequired: result.restartRequired,
  });
}
