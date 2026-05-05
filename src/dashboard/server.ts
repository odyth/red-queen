import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditLogger } from "../core/audit.js";
import type { TaskQueue } from "../core/queue.js";
import type { OrchestratorStateStore } from "../core/pipeline-state.js";
import type {
  ServiceInstallContext,
  ServiceManager,
  ServicePlatform,
} from "../core/service/index.js";
import type { Task } from "../core/types.js";
import {
  handleServicePartial,
  handleServiceRestart,
  handleServiceStart,
  handleServiceStatus,
  handleServiceStop,
} from "./api/service.js";
import { SSEManager } from "./events.js";
import type { DashboardEvent } from "./events.js";
import { renderShell } from "./html/shell.js";
import { renderStatusPartial } from "./html/partials/status.js";
import { renderServicePartial } from "./html/partials/service.js";

const LOGO_ASSET_PATH = "/assets/brand/logo.png";
const HTMX_ASSET_PATH = "/assets/htmx.min.js";

function resolveAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev: src/dashboard/server.ts -> ./assets
  // Built: dist/dashboard/server.js -> ./assets (postbuild copies src/dashboard/assets)
  return resolve(here, "assets");
}

function resolveLogoFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev: src/dashboard/server.ts -> ../../assets/brand/logo.png
  // Built: dist/dashboard/server.js -> ../../assets/brand/logo.png
  return resolve(here, "..", "..", "assets", "brand", "logo.png");
}

let cachedLogoBytes: Buffer | null = null;
let cachedHtmxBytes: Buffer | null = null;

function loadLogoBytes(): Buffer {
  cachedLogoBytes ??= readFileSync(resolveLogoFile());
  return cachedLogoBytes;
}

function loadHtmxBytes(): Buffer {
  cachedHtmxBytes ??= readFileSync(resolve(resolveAssetsDir(), "htmx.min.js"));
  return cachedHtmxBytes;
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

interface Route {
  method: string;
  path: string;
  handler: RouteHandler;
}

export interface DashboardServiceDeps {
  manager: ServiceManager;
  context: ServiceInstallContext;
}

export interface DashboardDeps {
  queue: TaskQueue;
  orchestratorState: OrchestratorStateStore;
  audit: AuditLogger;
  service?: DashboardServiceDeps;
}

export interface DashboardServerOptions {
  host: string;
  port: number;
  enableDashboardUi: boolean;
}

export class DashboardServer {
  private readonly deps: DashboardDeps;
  private readonly options: DashboardServerOptions;
  private readonly sse = new SSEManager();
  private readonly customRoutes: Route[] = [];
  private readonly builtInRoutes: Route[];
  private server: Server | null = null;
  private readonly startedAt = Date.now();

  constructor(deps: DashboardDeps, options: DashboardServerOptions) {
    this.deps = deps;
    this.options = options;
    this.builtInRoutes = this.buildRoutes();
  }

  registerRoute(method: string, path: string, handler: RouteHandler): void {
    this.customRoutes.push({ method: method.toUpperCase(), path, handler });
  }

  emit(event: DashboardEvent): void {
    this.sse.broadcast(event);
  }

  start(): Promise<void> {
    return new Promise((resolveStart, rejectStart) => {
      const server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: message }));
        });
      });
      server.on("error", rejectStart);
      server.listen(this.options.port, this.options.host, () => {
        this.server = server;
        resolveStart();
      });
    });
  }

  stop(): Promise<void> {
    this.sse.close();
    const server = this.server;
    if (server === null) {
      return Promise.resolve();
    }
    this.server = null;
    return new Promise((resolveStop, rejectStop) => {
      server.close((err) => {
        if (err) {
          rejectStop(err);
          return;
        }
        resolveStop();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const pathOnly = url.split("?")[0] ?? "/";
    // HEAD should match GET routes — Node's http server doesn't auto-convert.
    const lookupMethod = method === "HEAD" ? "GET" : method;

    for (const route of this.customRoutes) {
      if (route.method === lookupMethod && pathOnly === route.path) {
        await route.handler(req, res);
        return;
      }
    }

    for (const route of this.builtInRoutes) {
      if (route.method !== lookupMethod) {
        continue;
      }
      if (route.path !== pathOnly) {
        continue;
      }
      await route.handler(req, res);
      return;
    }

    this.sendText(res, 404, "Not Found");
  }

  private buildRoutes(): Route[] {
    const routes: Route[] = [];
    routes.push({
      method: "GET",
      path: "/health",
      handler: (_req, res) => {
        this.sendJson(res, 200, {
          status: "ok",
          uptime: Math.round((Date.now() - this.startedAt) / 1000),
        });
      },
    });

    if (this.options.enableDashboardUi === false) {
      return routes;
    }

    routes.push({
      method: "GET",
      path: "/",
      handler: (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderShell({ active: "status", content: renderStatusPartial() }));
      },
    });
    routes.push({
      method: "GET",
      path: LOGO_ASSET_PATH,
      handler: (_req, res) => {
        try {
          const bytes = loadLogoBytes();
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
          });
          res.end(bytes);
        } catch {
          this.sendText(res, 404, "Not Found");
        }
      },
    });
    routes.push({
      method: "GET",
      path: HTMX_ASSET_PATH,
      handler: (_req, res) => {
        try {
          const bytes = loadHtmxBytes();
          res.writeHead(200, {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          res.end(bytes);
        } catch {
          this.sendText(res, 404, "Not Found");
        }
      },
    });
    routes.push({
      method: "GET",
      path: "/api/status",
      handler: (_req, res) => {
        this.sendJson(res, 200, this.buildStatusPayload());
      },
    });
    routes.push({
      method: "GET",
      path: "/api/queue",
      handler: (_req, res) => {
        this.sendJson(res, 200, this.buildQueuePayload());
      },
    });
    routes.push({
      method: "GET",
      path: "/api/logs",
      handler: (_req, res) => {
        this.sendJson(res, 200, this.deps.audit.query({ limit: 50 }));
      },
    });
    routes.push({
      method: "GET",
      path: "/api/events",
      handler: (_req, res) => {
        this.sse.addClient(res);
      },
    });
    routes.push({
      method: "GET",
      path: "/api/status-partial",
      handler: (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderStatusPartial());
      },
    });
    routes.push({
      method: "GET",
      path: "/api/service-partial",
      handler: async (req, res) => {
        const service = this.deps.service;
        if (service === undefined) {
          const platform: ServicePlatform =
            process.platform === "darwin"
              ? "darwin"
              : process.platform === "linux"
                ? "linux"
                : "unsupported";
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            renderServicePartial({
              installed: false,
              running: false,
              name: "redqueen",
              pid: null,
              platform,
              stdoutLog: "",
              stderrLog: "",
            }),
          );
          return;
        }
        await handleServicePartial(req, res, service);
      },
    });

    if (this.deps.service !== undefined) {
      const service = this.deps.service;
      routes.push({
        method: "GET",
        path: "/api/service",
        handler: (req, res) => handleServiceStatus(req, res, service),
      });
      routes.push({
        method: "POST",
        path: "/api/service/start",
        handler: (req, res) => handleServiceStart(req, res, service),
      });
      routes.push({
        method: "POST",
        path: "/api/service/stop",
        handler: (req, res) => handleServiceStop(req, res, service),
      });
      routes.push({
        method: "POST",
        path: "/api/service/restart",
        handler: (req, res) => handleServiceRestart(req, res, service),
      });
    }

    return routes;
  }

  private buildStatusPayload(): Record<string, unknown> {
    const state = this.deps.orchestratorState.get();
    const ready = this.deps.queue.listByStatus("ready");
    const working = this.deps.queue.listByStatus("working");
    const currentTask = state.currentTaskId ? this.deps.queue.getTask(state.currentTaskId) : null;
    return {
      status: state.status,
      currentTaskId: state.currentTaskId,
      lastPoll: state.lastPoll,
      completedCount: state.completedCount,
      errorCount: state.errorCount,
      startedAt: state.startedAt,
      readyCount: ready.length,
      workingCount: working.length,
      currentTask: currentTask ? summarizeTask(currentTask) : null,
    };
  }

  private buildQueuePayload(): Record<string, unknown>[] {
    const ready = this.deps.queue.listByStatus("ready");
    return ready.map(summarizeTask);
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private sendText(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(body);
  }
}

function summarizeTask(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    type: task.type,
    priority: task.priority,
    issueId: task.issueId,
    status: task.status,
    description: task.description,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
  };
}
