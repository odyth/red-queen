import type { ServiceStatus } from "../../../core/service/index.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pillFor(status: ServiceStatus): { cls: string; label: string } {
  if (status.installed === false) {
    return { cls: "missing", label: "not installed" };
  }
  if (status.running) {
    return { cls: "running", label: "running" };
  }
  return { cls: "stopped", label: "stopped" };
}

export function renderServicePartial(status: ServiceStatus): string {
  const pill = pillFor(status);
  const pidLine =
    status.pid !== null
      ? `<dt>PID</dt><dd>${String(status.pid)}</dd>`
      : `<dt>PID</dt><dd class="muted">—</dd>`;

  const controls = status.installed
    ? `
    <div class="btn-row">
      <button hx-post="/api/service/start" hx-target="#service-panel" hx-swap="outerHTML">Start</button>
      <button hx-post="/api/service/stop" hx-target="#service-panel" hx-swap="outerHTML">Stop</button>
      <button hx-post="/api/service/restart" hx-target="#service-panel" hx-swap="outerHTML">Restart</button>
    </div>
  `
    : `<p>Run <code>redqueen service install</code> to enable service control.</p>`;

  return `<section id="service-panel" class="span2">
    <h2>Service</h2>
    <dl class="kv">
      <dt>Name</dt><dd>${escapeHtml(status.name)}</dd>
      <dt>Platform</dt><dd>${escapeHtml(status.platform)}</dd>
      <dt>State</dt><dd><span class="status-pill ${pill.cls}">${pill.label}</span></dd>
      ${pidLine}
      <dt>stdout log</dt><dd class="muted">${escapeHtml(status.stdoutLog)}</dd>
      <dt>stderr log</dt><dd class="muted">${escapeHtml(status.stderrLog)}</dd>
    </dl>
    ${controls}
  </section>`;
}
