import { api } from "../api.js";
import { escapeHtml, qs } from "../dom.js";
import type { CostSummaryPayload, CostTicketRow } from "../../shared/api-types.js";
import type { CostBreakdown, PhaseCostRow } from "../../../core/types.js";
import { formatTokens, formatUsd } from "../../../core/cost-format.js";

const COLUMN_COUNT = 5;

function renderRows(tickets: CostTicketRow[]): string {
  if (tickets.length === 0) {
    return `<tr><td colspan="${String(COLUMN_COUNT)}" class="empty">(no cost data yet)</td></tr>`;
  }
  return tickets.map(renderTicketRow).join("");
}

function renderTicketRow(t: CostTicketRow): string {
  const phase = t.currentPhase ?? "—";
  const phaseClass = t.currentPhase === null ? ' class="muted"' : "";
  const issueId = escapeHtml(t.issueId);
  return (
    `<tr class="cost-row" data-issue-id="${issueId}" style="border-bottom:1px dashed var(--border);cursor:pointer">` +
    `<td style="padding:6px 8px">` +
    `<span class="cost-chevron" aria-hidden="true" style="display:inline-block;width:10px;color:var(--muted);margin-right:6px">▸</span>` +
    `<strong>${issueId}</strong>` +
    `</td>` +
    `<td style="padding:6px 8px"${phaseClass}>${escapeHtml(phase)}</td>` +
    `<td style="padding:6px 8px;text-align:right">${String(t.runCount)}</td>` +
    `<td style="padding:6px 8px;text-align:right">${escapeHtml(formatUsd(t.totalCostUsd))}</td>` +
    `<td style="padding:6px 8px" class="muted">${escapeHtml(t.updatedAt)}</td>` +
    `</tr>` +
    `<tr class="cost-breakdown" data-issue-id="${issueId}" style="display:none">` +
    `<td colspan="${String(COLUMN_COUNT)}" style="padding:0 8px 10px 28px">` +
    `<div class="cost-breakdown-body muted">click to load…</div>` +
    `</td>` +
    `</tr>`
  );
}

function renderBreakdownTable(breakdown: CostBreakdown): string {
  const header =
    `<tr style="text-align:left;border-bottom:1px solid var(--border)">` +
    `<th style="padding:4px 8px">Phase</th>` +
    `<th style="padding:4px 8px;text-align:right">Iterations</th>` +
    `<th style="padding:4px 8px;text-align:right">Input</th>` +
    `<th style="padding:4px 8px;text-align:right">Output</th>` +
    `<th style="padding:4px 8px;text-align:right">Cache read</th>` +
    `<th style="padding:4px 8px;text-align:right">Cache write</th>` +
    `<th style="padding:4px 8px;text-align:right">Cost</th>` +
    `</tr>`;
  const body =
    breakdown.phases.length === 0
      ? `<tr><td colspan="7" class="muted" style="padding:6px 8px">(no phases recorded)</td></tr>`
      : breakdown.phases.map(renderPhaseRow).join("");
  const total =
    `<tr style="border-top:1px solid var(--border)">` +
    `<td style="padding:4px 8px"><strong>Total</strong></td>` +
    `<td></td><td></td><td></td><td></td><td></td>` +
    `<td style="padding:4px 8px;text-align:right"><strong>${escapeHtml(formatUsd(breakdown.totalCostUsd))}</strong></td>` +
    `</tr>`;
  return (
    `<table style="width:100%;border-collapse:collapse;margin-top:4px">` +
    `<thead>${header}</thead><tbody>${body}${total}</tbody></table>`
  );
}

function renderPhaseRow(row: PhaseCostRow): string {
  return (
    `<tr>` +
    `<td style="padding:4px 8px">${escapeHtml(row.phase)}</td>` +
    `<td style="padding:4px 8px;text-align:right">${String(row.iterations)}</td>` +
    `<td style="padding:4px 8px;text-align:right">${escapeHtml(formatTokens(row.usage.inputTokens))}</td>` +
    `<td style="padding:4px 8px;text-align:right">${escapeHtml(formatTokens(row.usage.outputTokens))}</td>` +
    `<td style="padding:4px 8px;text-align:right">${escapeHtml(formatTokens(row.usage.cacheReadTokens))}</td>` +
    `<td style="padding:4px 8px;text-align:right">${escapeHtml(formatTokens(row.usage.cacheCreationTokens))}</td>` +
    `<td style="padding:4px 8px;text-align:right">${escapeHtml(formatUsd(row.costUsd))}</td>` +
    `</tr>`
  );
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
      rows.innerHTML = `<tr><td colspan="${String(COLUMN_COUNT)}" class="err">error: ${escapeHtml(err instanceof Error ? err.message : String(err))}</td></tr>`;
    }
  }
}

async function toggleRow(issueId: string): Promise<void> {
  const selector = `tr.cost-breakdown[data-issue-id="${cssEscape(issueId)}"]`;
  const row = qs<HTMLTableRowElement>(selector);
  if (row === null) {
    return;
  }
  const chevron = qs<HTMLElement>(
    `tr.cost-row[data-issue-id="${cssEscape(issueId)}"] .cost-chevron`,
  );
  if (row.style.display === "none") {
    row.style.display = "";
    if (chevron !== null) {
      chevron.textContent = "▾";
    }
    if (row.dataset.loaded !== "true") {
      await loadBreakdown(row, issueId);
    }
    return;
  }
  row.style.display = "none";
  if (chevron !== null) {
    chevron.textContent = "▸";
  }
}

async function loadBreakdown(row: HTMLTableRowElement, issueId: string): Promise<void> {
  const body = row.querySelector<HTMLElement>(".cost-breakdown-body");
  if (body === null) {
    return;
  }
  body.textContent = "loading…";
  try {
    const payload = await api.getCostBreakdown(issueId);
    if (payload.ok === false) {
      body.className = "cost-breakdown-body err";
      body.textContent = `error: ${payload.error}`;
      return;
    }
    body.className = "cost-breakdown-body";
    body.innerHTML = renderBreakdownTable(payload.breakdown);
    row.dataset.loaded = "true";
  } catch (err) {
    body.className = "cost-breakdown-body err";
    body.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function cssEscape(value: string): string {
  // CSS.escape isn't available in every target browser — fall back to a
  // conservative manual escape. Issue IDs are typically [A-Z0-9-], so this
  // is defensive rather than frequently exercised.
  const native = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape;
  if (typeof native === "function") {
    return native(value);
  }
  return value.replace(/[^\w-]/g, (c) => `\\${c}`);
}

function handleClick(evt: Event): void {
  const target = evt.target;
  if (target === null || !(target instanceof Element)) {
    return;
  }
  const row = target.closest<HTMLTableRowElement>("tr.cost-row");
  if (row === null) {
    return;
  }
  const issueId = row.dataset.issueId;
  if (issueId === undefined) {
    return;
  }
  void toggleRow(issueId);
}

export function init(): void {
  const table = qs<HTMLElement>("#cost-table");
  if (table !== null && table.dataset.rqClickBound !== "true") {
    table.dataset.rqClickBound = "true";
    table.addEventListener("click", handleClick);
  }
  void refresh();
}
