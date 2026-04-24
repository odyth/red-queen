import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AuditLogger } from "../core/audit.js";
import type { TaskQueue } from "../core/queue.js";
import type { OrchestratorStateStore } from "../core/pipeline-state.js";
import type { Task } from "../core/types.js";
import { SSEManager } from "./events.js";
import type { DashboardEvent } from "./events.js";
import { renderDashboardHtml } from "./html.js";

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface DashboardDeps {
  queue: TaskQueue;
  orchestratorState: OrchestratorStateStore;
  audit: AuditLogger;
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
  private readonly customRoutes: {
    method: string;
    path: string;
    handler: RouteHandler;
  }[] = [];
  private server: Server | null = null;
  private readonly startedAt = Date.now();

  constructor(deps: DashboardDeps, options: DashboardServerOptions) {
    this.deps = deps;
    this.options = options;
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

    for (const route of this.customRoutes) {
      if (route.method === method && pathOnly === route.path) {
        await route.handler(req, res);
        return;
      }
    }

    if (method === "GET" && pathOnly === "/health") {
      this.sendJson(res, 200, {
        status: "ok",
        uptime: Math.round((Date.now() - this.startedAt) / 1000),
      });
      return;
    }

    if (this.options.enableDashboardUi === false) {
      this.sendText(res, 404, "Not Found");
      return;
    }

    if (method === "GET" && pathOnly === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderDashboardHtml());
      return;
    }

    if (method === "GET" && pathOnly === "/api/status") {
      this.sendJson(res, 200, this.buildStatusPayload());
      return;
    }

    if (method === "GET" && pathOnly === "/api/queue") {
      this.sendJson(res, 200, this.buildQueuePayload());
      return;
    }

    if (method === "GET" && pathOnly === "/api/logs") {
      this.sendJson(res, 200, this.deps.audit.query({ limit: 50 }));
      return;
    }

    if (method === "GET" && pathOnly === "/api/events") {
      this.sse.addClient(res);
      return;
    }

    this.sendText(res, 404, "Not Found");
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
