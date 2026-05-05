import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseDocument } from "yaml";
import { parseConfig, validatePhaseGraph } from "../../core/config.js";
import type { RedQueenConfig } from "../../core/config.js";
import type { TaskQueue } from "../../core/queue.js";
import type { RuntimeState } from "../../core/runtime-state.js";
import type { PhaseDefinition } from "../../core/types.js";

export interface WorkflowApiDeps {
  configPath: string;
  runtime: RuntimeState;
  queue: TaskQueue;
  reload: (newConfig: RedQueenConfig) => { applied: string[]; restartRequired: string[] };
}

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

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8" });
  renameSync(tmp, path);
}

export function handleWorkflowGet(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: WorkflowApiDeps,
): void {
  const phases = deps.runtime.config.phases;
  const entryPhases = deps.runtime.phaseGraph.getEntryPhases().map((p) => p.name);
  const humanGates = deps.runtime.phaseGraph.getHumanGates().map((p) => p.name);
  const validation = validatePhaseGraph(phases);
  sendJson(res, 200, {
    phases,
    entryPhases,
    humanGates,
    warnings: validation.warnings,
  });
}

function parsePhasesBody(body: string): PhaseDefinition[] | null {
  try {
    const parsed = JSON.parse(body) as { phases?: unknown };
    if (Array.isArray(parsed.phases) === false) {
      return null;
    }
    return parsed.phases as PhaseDefinition[];
  } catch {
    return null;
  }
}

export async function handleWorkflowValidate(
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
  const phases = parsePhasesBody(body);
  if (phases === null) {
    sendJson(res, 400, {
      ok: false,
      errors: ["invalid body: expected { phases: [...] }"],
      warnings: [],
    });
    return;
  }
  const result = validatePhaseGraph(phases);
  sendJson(res, 200, {
    ok: result.errors.length === 0,
    errors: result.errors,
    warnings: result.warnings,
  });
}

export async function handleWorkflowPut(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WorkflowApiDeps,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendText(res, 413, "Payload Too Large");
    return;
  }
  const phases = parsePhasesBody(body);
  if (phases === null) {
    sendJson(res, 400, {
      ok: false,
      errors: ["invalid body: expected { phases: [...] }"],
      warnings: [],
    });
    return;
  }

  const graphResult = validatePhaseGraph(phases);
  if (graphResult.errors.length > 0) {
    sendJson(res, 400, {
      ok: false,
      errors: graphResult.errors,
      warnings: graphResult.warnings,
    });
    return;
  }

  const open = deps.queue.getOpenCount();
  if (open.ready + open.working > 0) {
    sendJson(res, 409, {
      readyCount: open.ready,
      workingCount: open.working,
      message: `${String(open.ready + open.working)} open tasks; stop orchestrator and drain the queue.`,
    });
    return;
  }

  let existingYaml: string;
  try {
    existingYaml = readFileSync(deps.configPath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, errors: [`read failed: ${message}`], warnings: [] });
    return;
  }

  let newYaml: string;
  try {
    const doc = parseDocument(existingYaml);
    doc.set("phases", phases);
    newYaml = doc.toString();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, errors: [`yaml rewrite failed: ${message}`], warnings: [] });
    return;
  }

  let parsedConfig: RedQueenConfig;
  try {
    parsedConfig = parseConfig(newYaml);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, {
      ok: false,
      errors: [`rewritten config invalid: ${message}`],
      warnings: [],
    });
    return;
  }

  try {
    writeAtomic(deps.configPath, newYaml);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, errors: [`write failed: ${message}`], warnings: [] });
    return;
  }

  let reloadResult: { applied: string[]; restartRequired: string[] };
  try {
    reloadResult = deps.reload(parsedConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, errors: [`reload failed: ${message}`], warnings: [] });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    applied: reloadResult.applied,
    restartRequired: reloadResult.restartRequired,
  });
}
