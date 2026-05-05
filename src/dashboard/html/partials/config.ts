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
  </section>
<script>
  (function () {
    if (window.__rqConfigInit) { return; }
    window.__rqConfigInit = true;
    const qs = (s) => document.querySelector(s);
    const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]);
    async function load() {
      try {
        const res = await fetch('/api/config');
        const data = await res.json();
        qs('#config-yaml').value = data.yaml ?? '';
        renderEnv(data.envRefs ?? []);
        qs('#config-loader').style.display = 'none';
        qs('#config-form').style.display = 'block';
      } catch (err) {
        qs('#config-loader').textContent = 'error loading config: ' + err.message;
      }
    }
    function renderEnv(refs) {
      const el = qs('#config-env');
      if (!refs || refs.length === 0) {
        el.innerHTML = '<li class="empty">(none detected)</li>';
        return;
      }
      el.innerHTML = refs.map((r) =>
        '<li><code>\${' + escape(r.name) + '}</code> — ' +
        (r.set ? '<span class="ok">set</span>' : '<span class="err">not set</span>') +
        '</li>'
      ).join('');
    }
    function setMessage(html, cls) {
      const el = qs('#config-message');
      el.className = cls || '';
      el.innerHTML = html;
    }
    function setRestartBanner(restartRequired) {
      const el = qs('#config-restart');
      if (!restartRequired || restartRequired.length === 0) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
      }
      el.style.display = 'block';
      el.innerHTML =
        'Restart required for: ' + restartRequired.map(escape).join(', ') +
        '. <button type="button" id="config-restart-btn">Restart now</button>';
      const btn = qs('#config-restart-btn');
      if (btn) {
        btn.addEventListener('click', async () => {
          try {
            await fetch('/api/service/restart', { method: 'POST' });
            setMessage('<span class="ok">restart dispatched</span>');
          } catch (err) {
            setMessage('<span class="err">restart failed: ' + escape(err.message) + '</span>');
          }
        });
      }
    }
    qs('#config-validate-btn').addEventListener('click', async () => {
      setMessage('validating…', 'muted');
      try {
        const yaml = qs('#config-yaml').value;
        const res = await fetch('/api/config/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: yaml,
        });
        const data = await res.json();
        if (data.ok) {
          setMessage('<span class="ok">valid</span>' +
            (data.warnings && data.warnings.length > 0
              ? '<br><span class="warn">warnings:</span><ul>' +
                data.warnings.map((w) => '<li class="warn">' + escape(w) + '</li>').join('') + '</ul>'
              : ''));
        } else {
          setMessage('<span class="err">invalid</span><ul>' +
            (data.errors || []).map((e) => '<li class="err">' + escape(e) + '</li>').join('') +
            '</ul>');
        }
      } catch (err) {
        setMessage('<span class="err">validate failed: ' + escape(err.message) + '</span>');
      }
    });
    qs('#config-save-btn').addEventListener('click', async () => {
      setMessage('saving…', 'muted');
      try {
        const yaml = qs('#config-yaml').value;
        const res = await fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: yaml,
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          const applied = data.applied || [];
          setMessage('<span class="ok">saved</span>' +
            (applied.length > 0
              ? '<br>applied: ' + applied.map(escape).join(', ')
              : ''));
          setRestartBanner(data.restartRequired || []);
          load();
        } else {
          setMessage('<span class="err">save failed</span><ul>' +
            (data.errors || []).map((e) => '<li class="err">' + escape(e) + '</li>').join('') +
            '</ul>');
        }
      } catch (err) {
        setMessage('<span class="err">save failed: ' + escape(err.message) + '</span>');
      }
    });
    qs('#config-reload-btn').addEventListener('click', () => { load(); });
    load();
  })();
</script>`;
}

export function renderConfigPartialSafeTitle(title: string): string {
  return escapeHtml(title);
}
