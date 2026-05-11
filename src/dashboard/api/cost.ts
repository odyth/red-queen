import type { IncomingMessage, ServerResponse } from "node:http";
import type { PhaseUsageStore } from "../../core/phase-usage.js";
import type { CostSummaryPayload } from "../shared/api-types.js";

export interface CostApiDeps {
  phaseUsage: PhaseUsageStore;
  costEnabled: boolean;
  model: string;
}

export function handleCostSummary(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: CostApiDeps,
): void {
  const payload = buildCostSummary(deps);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
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
    })),
    updatedAt: new Date().toISOString(),
  };
}
