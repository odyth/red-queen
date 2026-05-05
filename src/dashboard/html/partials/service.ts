import type { ServiceStatus } from "../../../core/service/index.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pillFor(status: ServiceStatus): { cls: string; label: string } {
  if (status.platform === "unsupported") {
    return { cls: "missing", label: "unsupported" };
  }
  if (status.installed === false) {
    return { cls: "missing", label: "not installed" };
  }
  if (status.running) {
    return { cls: "running", label: "running" };
  }
  return { cls: "stopped", label: "stopped" };
}

export interface RenderServicePartialOptions {
  /**
   * True when the partial is the optimistic response to a Stop click — the
   * dashboard is about to die with the service. Render a copy-friendly
   * instruction block instead of a Start button that would post to a dead
   * server. When the service is restarted externally and the user reloads
   * the dashboard, the normal partial path renders the Start button again.
   */
  terminal?: boolean;
}

export function renderServicePartial(
  status: ServiceStatus,
  options: RenderServicePartialOptions = {},
): string {
  if (status.platform === "unsupported") {
    return `<section id="service-panel" class="span2">
    <h2>Service</h2>
    <p class="muted">Service installer is only supported on macOS (launchd) and Linux (systemd --user). Run <code>redqueen start</code> as a foreground process or use your platform's scheduler directly.</p>
  </section>`;
  }

  const pill = pillFor(status);
  const pidLine =
    status.pid !== null
      ? `<dt>PID</dt><dd>${String(status.pid)}</dd>`
      : `<dt>PID</dt><dd class="muted">—</dd>`;

  let controls: string;
  if (options.terminal === true) {
    controls = `
    <p class="muted">Service stopped. This dashboard is served by the service and is no longer reachable once shutdown completes.</p>
    <p>Run <code>redqueen service start</code> in a terminal to bring it back.</p>
  `;
  } else if (status.installed) {
    controls = `
    <div class="btn-row">
      <button hx-post="/api/service/start" hx-target="#service-panel" hx-swap="outerHTML">Start</button>
      <button hx-post="/api/service/stop" hx-target="#service-panel" hx-swap="outerHTML">Stop</button>
      <button hx-post="/api/service/restart" hx-target="#service-panel" hx-swap="outerHTML">Restart</button>
    </div>
  `;
  } else {
    controls = `<p>Run <code>redqueen service install</code> to enable service control.</p>`;
  }

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
