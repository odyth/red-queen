import type { IncomingMessage, ServerResponse } from "node:http";
import type { PhaseUsageStore } from "../../core/phase-usage.js";
import type { CostBreakdown } from "../../core/types.js";
import type { CostBreakdownPayload, CostSummaryPayload } from "../shared/api-types.js";

export interface CostApiDeps {
  phaseUsage: PhaseUsageStore;
  costEnabled: boolean;
  model: string;
  buildBreakdown: (issueId: string) => CostBreakdown;
}

export function handleCostSummary(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: CostApiDeps,
): void {
  sendJson(res, 200, buildCostSummary(deps));
}

export function buildCostSummary(deps: CostApiDeps): CostSummaryPayload {
  if (deps.costEnabled === false) {
    return {
      enabled: false,
      model: deps.model,
      totalCostUsd: 0,
      tickets: [],
      updatedAt: new Date().toISOString(),
    };
  }
  const tickets = deps.phaseUsage.listTicketSummaries();
  return {
    enabled: true,
    model: deps.model,
    totalCostUsd: deps.phaseUsage.totalCostAcrossTickets(),
    tickets: tickets.map((t) => ({
      issueId: t.issueId,
      totalCostUsd: t.totalCostUsd,
      runCount: t.runCount,
      updatedAt: t.updatedAt,
      currentPhase: t.currentPhase,
    })),
    updatedAt: new Date().toISOString(),
  };
}

export function handleCostBreakdown(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CostApiDeps,
): void {
  const url = new URL(req.url ?? "", "http://localhost");
  const issueId = url.searchParams.get("issueId") ?? "";
  if (issueId === "") {
    sendJson(res, 400, {
      ok: false,
      issueId: "",
      error: "issueId query parameter is required",
    } satisfies CostBreakdownPayload);
    return;
  }
  if (deps.costEnabled === false) {
    sendJson(res, 400, {
      ok: false,
      issueId,
      error: "cost tracking is disabled",
    } satisfies CostBreakdownPayload);
    return;
  }
  const breakdown = deps.buildBreakdown(issueId);
  if (breakdown.phases.length === 0) {
    sendJson(res, 404, {
      ok: false,
      issueId,
      error: `no cost data recorded for issue ${issueId}`,
    } satisfies CostBreakdownPayload);
    return;
  }
  sendJson(res, 200, { ok: true, issueId, breakdown } satisfies CostBreakdownPayload);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
