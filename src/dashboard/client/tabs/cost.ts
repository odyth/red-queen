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
  const updatedAt = escapeHtml(t.updatedAt);
  return (
    `<tr class="cost-row" role="button" tabindex="0" aria-expanded="false" data-issue-id="${issueId}" data-updated-at="${updatedAt}" style="border-bottom:1px dashed var(--border);cursor:pointer">` +
    `<td style="padding:6px 8px">` +
    `<span class="cost-chevron" aria-hidden="true" style="display:inline-block;width:10px;color:var(--muted);margin-right:6px">▸</span>` +
    `<strong>${issueId}</strong>` +
    `</td>` +
    `<td style="padding:6px 8px"${phaseClass}>${escapeHtml(phase)}</td>` +
    `<td style="padding:6px 8px;text-align:right">${String(t.runCount)}</td>` +
    `<td style="padding:6px 8px;text-align:right">${escapeHtml(formatUsd(t.totalCostUsd))}</td>` +
    `<td style="padding:6px 8px" class="muted">${updatedAt}</td>` +
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
    // Capture which rows the user had expanded so we can restore them after
    // the innerHTML replace — otherwise every refresh collapses the drill-
    // down the user is actively reading.
    const expandedIds = new Set<string>();
    for (const r of rows.querySelectorAll<HTMLTableRowElement>("tr.cost-row")) {
      if (r.getAttribute("aria-expanded") === "true") {
        const id = r.dataset.issueId;
        if (id !== undefined) {
          expandedIds.add(id);
        }
      }
    }
    rows.innerHTML = renderRows(payload.tickets);
    for (const t of payload.tickets) {
      if (expandedIds.has(t.issueId) === true) {
        void reexpand(t.issueId);
      }
    }
  }
}

async function reexpand(issueId: string): Promise<void> {
  const parent = findParentRow(issueId);
  const breakdownRow = findBreakdownRow(issueId);
  if (parent === null || breakdownRow === null) {
    return;
  }
  setExpandedState(parent, breakdownRow, true);
  // innerHTML was just replaced, so the breakdown row is fresh DOM —
  // always refetch. Gives us current data for free.
  await loadBreakdown(breakdownRow, issueId);
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
  const parent = findParentRow(issueId);
  const breakdownRow = findBreakdownRow(issueId);
  if (parent === null || breakdownRow === null) {
    return;
  }
  const isOpen = breakdownRow.style.display !== "none";
  if (isOpen === true) {
    setExpandedState(parent, breakdownRow, false);
    return;
  }
  setExpandedState(parent, breakdownRow, true);
  // Re-fetch if the ticket's updatedAt moved since the last load — the
  // rollup row gets refreshed live on SSE-driven refresh(), so the
  // breakdown shouldn't lag behind.
  const currentUpdatedAt = parent.dataset.updatedAt ?? "";
  const loadedAt = breakdownRow.dataset.loadedAt ?? "";
  const needsLoad = breakdownRow.dataset.loaded !== "true" || loadedAt !== currentUpdatedAt;
  if (needsLoad === true) {
    await loadBreakdown(breakdownRow, issueId);
  }
}

function findParentRow(issueId: string): HTMLTableRowElement | null {
  return qs<HTMLTableRowElement>(`tr.cost-row[data-issue-id="${cssEscape(issueId)}"]`);
}

function findBreakdownRow(issueId: string): HTMLTableRowElement | null {
  return qs<HTMLTableRowElement>(`tr.cost-breakdown[data-issue-id="${cssEscape(issueId)}"]`);
}

function setExpandedState(
  parent: HTMLTableRowElement,
  breakdownRow: HTMLTableRowElement,
  expanded: boolean,
): void {
  breakdownRow.style.display = expanded === true ? "" : "none";
  parent.setAttribute("aria-expanded", expanded === true ? "true" : "false");
  const chevron = parent.querySelector<HTMLElement>(".cost-chevron");
  if (chevron !== null) {
    chevron.textContent = expanded === true ? "▾" : "▸";
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
    // Stamp the parent's updatedAt onto the breakdown row so the next
    // apply() can decide whether the cached breakdown is still current.
    const parent = findParentRow(issueId);
    if (parent !== null) {
      row.dataset.loadedAt = parent.dataset.updatedAt ?? "";
    }
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

function handleKeydown(evt: KeyboardEvent): void {
  if (evt.key !== "Enter" && evt.key !== " ") {
    return;
  }
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
  // Space otherwise scrolls the page; Enter is the default activation key
  // so keeping the same behavior here avoids surprising keyboard users.
  evt.preventDefault();
  void toggleRow(issueId);
}

export function init(): void {
  const table = qs<HTMLElement>("#cost-table");
  if (table !== null && table.dataset.rqClickBound !== "true") {
    table.dataset.rqClickBound = "true";
    table.addEventListener("click", handleClick);
    table.addEventListener("keydown", handleKeydown);
  }
  void refresh();
}
