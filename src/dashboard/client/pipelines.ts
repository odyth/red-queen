import type { PipelineWire } from "../shared/api-types.js";
import { api } from "./api.js";
import { escapeHtml, qs } from "./dom.js";

export function renderPipelines(items: PipelineWire[] | null): string {
  if (items === null || items.length === 0) {
    return '<li class="empty">(none)</li>';
  }
  return items
    .map((pipeline) => {
      const rows = pipeline.repos
        .map((row) => {
          const pr = row.prNumber === null ? "—" : `PR #${String(row.prNumber)}`;
          const scope = row.inScope ? "in-scope" : "descoped";
          const orphaned = row.orphaned ? ' · <span class="err">orphaned</span>' : "";
          return (
            `<li><strong>${escapeHtml(row.repo)}</strong> · ` +
            `${escapeHtml(row.branchName ?? "—")} · ${escapeHtml(pr)} · ` +
            `<span class="muted">${scope}</span>${orphaned}</li>`
          );
        })
        .join("");
      return (
        `<li><strong>${escapeHtml(pipeline.issueId)}</strong> ` +
        `<span class="muted">${escapeHtml(pipeline.currentPhase ?? "—")}</span>` +
        `<ul class="pipeline-repos">${rows}</ul></li>`
      );
    })
    .join("");
}

export function setPipelines(items: PipelineWire[] | null): void {
  const el = qs("#pipelines");
  if (el !== null) {
    el.innerHTML = renderPipelines(items);
  }
}

export async function refreshPipelines(): Promise<void> {
  const el = qs("#pipelines");
  if (el === null) {
    return;
  }
  try {
    // Keep this refresh independent of workflow editing so live updates preserve unsaved fields.
    el.innerHTML = renderPipelines(await api.getPipelines());
  } catch (err) {
    el.innerHTML = `<li class="err">Could not load pipelines: ${escapeHtml(err instanceof Error ? err.message : String(err))}</li>`;
  }
}
