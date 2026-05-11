import { api } from "../api.js";
import { escapeHtml, qs } from "../dom.js";
import type { CostSummaryPayload, CostTicketRow } from "../../shared/api-types.js";

function formatUsd(n: number): string {
  if (n === 0) {
    return "$0.00";
  }
  if (n < 0.01) {
    return "<$0.01";
  }
  return `$${n.toFixed(2)}`;
}

function renderRows(tickets: CostTicketRow[]): string {
  if (tickets.length === 0) {
    return '<tr><td colspan="4" class="empty">(no cost data yet)</td></tr>';
  }
  return tickets
    .map(
      (t) =>
        `<tr style="border-bottom:1px dashed var(--border)">` +
        `<td style="padding:6px 8px"><strong>${escapeHtml(t.issueId)}</strong></td>` +
        `<td style="padding:6px 8px;text-align:right">${String(t.runCount)}</td>` +
        `<td style="padding:6px 8px;text-align:right">${escapeHtml(formatUsd(t.totalCostUsd))}</td>` +
        `<td style="padding:6px 8px" class="muted">${escapeHtml(t.updatedAt)}</td>` +
        `</tr>`,
    )
    .join("");
}

function apply(payload: CostSummaryPayload): void {
  const disabled = qs<HTMLElement>("#cost-disabled");
  const body = qs<HTMLElement>("#cost-body");
  if (payload.enabled === false) {
    if (disabled) {
      disabled.style.display = "";
    }
    if (body) {
      body.style.display = "none";
    }
    return;
  }
  if (disabled) {
    disabled.style.display = "none";
  }
  if (body) {
    body.style.display = "";
  }
  const model = qs("#cost-model");
  if (model) {
    model.textContent = payload.model;
  }
  const total = qs("#cost-total");
  if (total) {
    total.textContent = formatUsd(payload.totalCostUsd);
  }
  const updated = qs("#cost-updated");
  if (updated) {
    updated.textContent = payload.updatedAt;
  }
  const rows = qs("#cost-rows");
  if (rows) {
    rows.innerHTML = renderRows(payload.tickets);
  }
}

export async function refresh(): Promise<void> {
  try {
    const payload = await api.getCostSummary();
    apply(payload);
  } catch (err) {
    const rows = qs("#cost-rows");
    if (rows) {
      rows.innerHTML = `<tr><td colspan="4" class="err">error: ${escapeHtml(err instanceof Error ? err.message : String(err))}</td></tr>`;
    }
  }
}

export function init(): void {
  void refresh();
}
