import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ServiceInstallContext,
  ServiceManager,
  ServiceStatus,
} from "../../core/service/index.js";
import { renderServicePartial } from "../html/partials/service.js";

export interface ServiceApiDeps {
  manager: ServiceManager;
  context: ServiceInstallContext;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

async function readStatus(deps: ServiceApiDeps): Promise<ServiceStatus> {
  return deps.manager.status(deps.context);
}

export async function handleServiceStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ServiceApiDeps,
): Promise<void> {
  const status = await readStatus(deps);
  sendJson(res, 200, status);
}

export async function handleServicePartial(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ServiceApiDeps,
): Promise<void> {
  const status = await readStatus(deps);
  sendHtml(res, 200, renderServicePartial(status));
}

async function runAction(
  action: "start" | "stop" | "restart",
  deps: ServiceApiDeps,
  res: ServerResponse,
): Promise<void> {
  try {
    if (action === "start") {
      await deps.manager.start(deps.context);
    } else if (action === "stop") {
      await deps.manager.stop(deps.context);
    } else {
      await deps.manager.restart(deps.context);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Stop/restart may kill the dashboard itself before we finish rendering —
    // but that's benign: the caller gets the response before the process exits,
    // or the HTMX retry kicks in on reconnect. Surface other failures as 500.
    sendHtml(
      res,
      500,
      `<section id="service-panel" class="span2"><h2>Service</h2><p class="err">${escapeHtml(
        `${action} failed: ${message}`,
      )}</p></section>`,
    );
    return;
  }
  const status = await readStatus(deps);
  sendHtml(res, 200, renderServicePartial(status));
}

export async function handleServiceStart(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ServiceApiDeps,
): Promise<void> {
  await runAction("start", deps, res);
}

export async function handleServiceStop(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ServiceApiDeps,
): Promise<void> {
  await runAction("stop", deps, res);
}

export async function handleServiceRestart(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ServiceApiDeps,
): Promise<void> {
  await runAction("restart", deps, res);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
