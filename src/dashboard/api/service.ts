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

function projectStatus(current: ServiceStatus, target: "running" | "stopped"): ServiceStatus {
  return {
    ...current,
    running: target === "running",
    pid: target === "running" ? current.pid : null,
  };
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

export async function handleServiceStart(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ServiceApiDeps,
): Promise<void> {
  try {
    await deps.manager.start(deps.context);
  } catch (err) {
    sendError(res, "start", err);
    return;
  }
  const status = await readStatus(deps);
  sendHtml(res, 200, renderServicePartial(status));
}

/**
 * Stop/restart may terminate the current process (when the dashboard is
 * running inside the service it's tearing down). Reply with a predicted
 * partial BEFORE invoking the manager, so the HTTP response reaches the
 * client even if SIGTERM arrives mid-flight. The real state reconciles
 * on the next poll / HTMX interaction.
 */
export async function handleServiceStop(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ServiceApiDeps,
): Promise<void> {
  const current = await readStatus(deps);
  sendHtml(res, 200, renderServicePartial(projectStatus(current, "stopped"), { terminal: true }));
  setImmediate(() => {
    void deps.manager.stop(deps.context).catch(() => {
      // Silent: response already sent. Logs will surface the failure.
    });
  });
}

export async function handleServiceRestart(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ServiceApiDeps,
): Promise<void> {
  const current = await readStatus(deps);
  sendHtml(res, 200, renderServicePartial(projectStatus(current, "running")));
  setImmediate(() => {
    void deps.manager.restart(deps.context).catch(() => {
      // Silent: response already sent. Logs will surface the failure.
    });
  });
}

function sendError(res: ServerResponse, action: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  sendHtml(
    res,
    500,
    `<section id="service-panel" class="span2"><h2>Service</h2><p class="err">${escapeHtml(
      `${action} failed: ${message}`,
    )}</p></section>`,
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
