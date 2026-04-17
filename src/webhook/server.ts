import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuditLogger } from "../core/audit.js";
import type { TaskQueue } from "../core/queue.js";
import type { PipelineStateStore } from "../core/pipeline-state.js";
import type { PhaseGraph, PipelineEvent } from "../core/types.js";
import type { IssueTracker } from "../integrations/issue-tracker.js";
import type { SourceControl } from "../integrations/source-control.js";
import type { DashboardServer, RouteHandler } from "../dashboard/server.js";

export interface WebhookServerDeps {
  issueTracker: IssueTracker;
  sourceControl: SourceControl;
  queue: TaskQueue;
  pipelineState: PipelineStateStore;
  phaseGraph: PhaseGraph;
  audit: AuditLogger;
  onEvent?: (event: PipelineEvent) => void;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class WebhookServer {
  private readonly deps: WebhookServerDeps;

  constructor(deps: WebhookServerDeps) {
    this.deps = deps;
  }

  register(dashboard: DashboardServer): void {
    dashboard.registerRoute(
      "POST",
      "/webhook/issue-tracker",
      this.handleIssueTracker.bind(this) as RouteHandler,
    );
    dashboard.registerRoute(
      "POST",
      "/webhook/source-control",
      this.handleSourceControl.bind(this) as RouteHandler,
    );
  }

  private async handleIssueTracker(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.handleAdapter(req, res, "issue-tracker", {
      validate: (headers, body) => this.deps.issueTracker.validateWebhook(headers, body),
      parse: (headers, body) => this.deps.issueTracker.parseWebhookEvent(headers, body),
    });
  }

  private async handleSourceControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.handleAdapter(req, res, "source-control", {
      validate: (headers, body) => this.deps.sourceControl.validateWebhook(headers, body),
      parse: (headers, body) => this.deps.sourceControl.parseWebhookEvent(headers, body),
    });
  }

  private async handleAdapter(
    req: IncomingMessage,
    res: ServerResponse,
    component: string,
    handlers: {
      validate: (headers: Record<string, string>, body: string) => boolean;
      parse: (headers: Record<string, string>, body: string) => PipelineEvent | null;
    },
  ): Promise<void> {
    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      this.deps.audit.log({
        component,
        issueId: null,
        message: `Webhook body read failed: ${errorMessage(err)}`,
        metadata: {},
      });
      res.writeHead(413, { "Content-Type": "text/plain" });
      res.end("Payload Too Large");
      return;
    }

    const headers = normalizeHeaders(req.headers);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
    if (handlers.validate(headers, body) === false) {
      this.deps.audit.log({
        component,
        issueId: null,
        message: "Webhook rejected: invalid signature",
        metadata: {},
      });
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    let event: PipelineEvent | null;
    try {
      event = handlers.parse(headers, body);
    } catch (err) {
      this.deps.audit.log({
        component,
        issueId: null,
        message: `Webhook parse failed: ${errorMessage(err)}`,
        metadata: {},
      });
      return;
    }

    if (event === null) {
      return;
    }

    try {
      this.dispatchEvent(event, component);
    } catch (err) {
      this.deps.audit.log({
        component,
        issueId: event.issueId,
        message: `Webhook dispatch failed: ${errorMessage(err)}`,
        metadata: { eventType: event.type },
      });
    }
  }

  private dispatchEvent(event: PipelineEvent, component: string): void {
    const { queue, phaseGraph, pipelineState, audit } = this.deps;

    switch (event.type) {
      case "phase-change": {
        const phaseName = extractString(event.payload, "phase");
        if (phaseName === null) {
          return;
        }
        if (phaseGraph.isHumanGate(phaseName)) {
          audit.log({
            component,
            issueId: event.issueId,
            message: `phase-change to human gate ${phaseName} — no task created`,
            metadata: { phase: phaseName },
          });
          break;
        }
        const phase = phaseGraph.getPhase(phaseName);
        if (phase === undefined) {
          audit.log({
            component,
            issueId: event.issueId,
            message: `phase-change references unknown phase ${phaseName}`,
            metadata: { phase: phaseName },
          });
          return;
        }
        if (queue.hasOpenTask(event.issueId, phaseName)) {
          break;
        }
        queue.enqueue({
          type: phaseName,
          issueId: event.issueId,
          priority: phase.priority,
          description: `Phase change from webhook`,
        });
        break;
      }
      case "pr-feedback": {
        const record = pipelineState.get(event.issueId);
        const hasPr = record !== null && record.prNumber !== null;
        const taskType = hasPr ? "code-feedback" : "spec-feedback";
        if (queue.hasOpenTask(event.issueId, taskType)) {
          break;
        }
        queue.enqueue({
          type: taskType,
          issueId: event.issueId,
          priority: 0,
          description: "PR feedback",
        });
        break;
      }
      case "pr-merged": {
        const record = pipelineState.get(event.issueId);
        if (record !== null) {
          pipelineState.updatePhase(event.issueId, "done");
        }
        audit.log({
          component,
          issueId: event.issueId,
          message: "PR merged — pipeline marked done",
          metadata: {},
        });
        break;
      }
      case "assignment-change": {
        const record = pipelineState.get(event.issueId);
        if (record !== null && record.currentPhase !== null) {
          break;
        }
        if (queue.hasOpenTask(event.issueId, "new-ticket")) {
          break;
        }
        queue.enqueue({
          type: "new-ticket",
          issueId: event.issueId,
          description: "Assigned to AI",
        });
        break;
      }
      case "new-ticket": {
        if (queue.hasOpenTask(event.issueId, "new-ticket")) {
          break;
        }
        queue.enqueue({
          type: "new-ticket",
          issueId: event.issueId,
          description: "New ticket",
        });
        break;
      }
    }

    if (this.deps.onEvent) {
      this.deps.onEvent(event);
    }
  }
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

function normalizeHeaders(raw: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  return out;
}

function extractString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
