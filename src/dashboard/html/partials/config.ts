function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderConfigPartial(): string {
  return `<section id="config-panel" class="span2">
    <h2>Config</h2>
    <div id="config-loader" class="muted">loading…</div>
    <div id="config-form" style="display:none">
      <div class="btn-row" style="margin-bottom:10px">
        <button id="config-validate-btn" type="button">Validate</button>
        <button id="config-save-btn" type="button">Save</button>
        <button id="config-reload-btn" type="button">Reload from disk</button>
      </div>
      <textarea id="config-yaml" style="width:100%;height:480px;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px;font-family:inherit;font-size:12px;" spellcheck="false"></textarea>
      <div id="config-message" style="margin-top:8px"></div>
      <div id="config-restart" style="margin-top:8px;display:none" class="warn"></div>
      <h3 style="margin-top:18px;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted)">Referenced env vars</h3>
      <ul id="config-env" class="muted"><li class="empty">(none detected)</li></ul>
      <p class="muted" style="margin-top:6px">Literal secret values are rejected on save. Use <code>\${VAR}</code> placeholders.</p>
    </div>
  </section>`;
}

export function renderConfigPartialSafeTitle(title: string): string {
  return escapeHtml(title);
}
