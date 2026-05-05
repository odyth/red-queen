export type NavKey = "status" | "service" | "config" | "skills" | "workflow";

export interface NavTab {
  key: NavKey;
  label: string;
  partialPath: string;
}

export const NAV_TABS: readonly NavTab[] = [
  { key: "status", label: "Status", partialPath: "/api/status-partial" },
  { key: "service", label: "Service", partialPath: "/api/service-partial" },
  { key: "config", label: "Config", partialPath: "/api/config-partial" },
  { key: "skills", label: "Skills", partialPath: "/api/skills-partial" },
  { key: "workflow", label: "Workflow", partialPath: "/api/workflow-partial" },
];

export interface ShellOptions {
  active: NavKey;
  content: string;
}

const STYLES = `
  :root {
    color-scheme: dark;
    --bg: #0f1115;
    --panel: #171a21;
    --border: #2a2f3a;
    --text: #e6e8eb;
    --muted: #7d8595;
    --accent: #d14343;
    --ok: #4ade80;
    --warn: #facc15;
    --err: #f87171;
  }
  body {
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    line-height: 1.4;
  }
  header {
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 12px;
  }
  header h1 {
    margin: 0;
    font-size: 14px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }
  header .logo {
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    display: block;
  }
  header .tagline {
    color: var(--muted);
    font-size: 12px;
    letter-spacing: 0.02em;
  }
  header .status {
    margin-left: auto;
    color: var(--muted);
  }
  nav.tabs {
    display: flex;
    gap: 4px;
    padding: 0 20px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  nav.tabs button {
    background: transparent;
    border: 0;
    color: var(--muted);
    padding: 10px 14px;
    font-family: inherit;
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  nav.tabs button:hover {
    color: var(--text);
  }
  nav.tabs button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  main {
    display: grid;
    grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);
    gap: 12px;
    padding: 12px 20px 40px;
  }
  main.single {
    grid-template-columns: 1fr;
  }
  section {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 12px 14px;
  }
  section h2 {
    margin: 0 0 10px;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .kv {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 4px 10px;
  }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 4px 0; border-bottom: 1px dashed var(--border); }
  li:last-child { border-bottom: 0; }
  .pill {
    display: inline-block;
    padding: 0 6px;
    border-radius: 3px;
    background: #222832;
    font-size: 11px;
    margin-right: 6px;
  }
  .p0 { color: var(--err); }
  .p1 { color: var(--warn); }
  .pN { color: var(--muted); }
  .ok { color: var(--ok); }
  .warn { color: var(--warn); }
  .err { color: var(--err); }
  .muted { color: var(--muted); }
  .span2 { grid-column: span 2; }
  .empty { color: var(--muted); font-style: italic; }
  .log { font-size: 12px; max-height: 360px; overflow-y: auto; }
  .log li { white-space: pre-wrap; word-break: break-word; }
  .btn-row {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .btn-row button {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 12px;
    font-family: inherit;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
    border-radius: 3px;
  }
  .btn-row button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .btn-row button[disabled] {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .status-pill {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .status-pill.running { background: rgba(74, 222, 128, 0.15); color: var(--ok); }
  .status-pill.stopped { background: rgba(125, 133, 149, 0.2); color: var(--muted); }
  .status-pill.unknown { background: rgba(250, 204, 21, 0.15); color: var(--warn); }
  .status-pill.missing { background: rgba(248, 113, 113, 0.15); color: var(--err); }
`;

// Client-side controller bundle. Lives in the shell (not in swapped
// partials) so browser HTML parsing runs it once at page load — bypasses
// htmx's allowScriptTags:false policy, which would otherwise silently
// drop <script> tags inside partials swapped into #main.
//
// Each tab exposes an init function keyed by data-tab. After every htmx
// swap into #main we run the matching init against the freshly rendered
// DOM. Global SSE/uptime listeners live here too and are null-safe: they
// only touch elements that currently exist.
const CONTROLLER_JS = `
(function () {
  if (window.__rqShellInit) { return; }
  window.__rqShellInit = true;

  var qs = function (sel, root) { return (root || document).querySelector(sel); };
  var qsa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var escape = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var fmtDuration = function (seconds) {
    var s = Math.max(0, Math.floor(Number(seconds) || 0));
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    return d + 'd ' + h + 'h ' + m + 'm ' + s + 's';
  };
  var fmtPriority = function (p) {
    if (p === 0) return '<span class="pill p0">P0</span>';
    if (p === 1) return '<span class="pill p1">P1</span>';
    return '<span class="pill pN">P' + p + '</span>';
  };

  // Track the started-at timestamp outside the status DOM so the header
  // uptime ticker survives tab switches.
  var startedAtMs = null;
  function setStartedAt(iso) {
    if (iso == null || iso === '' || iso === '—') { return; }
    var ms = new Date(iso).getTime();
    if (isFinite(ms)) { startedAtMs = ms; }
  }
  setInterval(function () {
    var el = qs('#uptime');
    if (el == null) { return; }
    if (startedAtMs == null) {
      el.textContent = '';
      return;
    }
    var diff = Math.round((Date.now() - startedAtMs) / 1000);
    el.textContent = 'uptime ' + fmtDuration(diff);
  }, 1000);

  // --------------- Tab switching ---------------
  // Update .active on nav buttons when the user clicks a tab. htmx swaps
  // #main for us; this just keeps the underline in sync with what's shown.
  document.body.addEventListener('click', function (evt) {
    var btn = evt.target && evt.target.closest ? evt.target.closest('nav.tabs button[data-tab]') : null;
    if (btn == null) { return; }
    qsa('nav.tabs button[data-tab]').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
  });

  // --------------- Status tab ---------------
  var rqStatus = (function () {
    function setWorker(task) {
      var ws = qs('#worker-status');
      if (ws == null) { return; }
      if (task == null || task.status !== 'working') {
        ws.textContent = 'idle'; ws.className = 'muted';
        qs('#worker-issue').textContent = '—';
        qs('#worker-task').textContent = '—';
        qs('#worker-elapsed').textContent = '—';
        qs('#worker-heartbeat').textContent = '—';
        return;
      }
      ws.textContent = 'working'; ws.className = 'ok';
      qs('#worker-issue').textContent = task.issueId == null ? '—' : task.issueId;
      qs('#worker-task').textContent = task.type + (task.description ? ' — ' + task.description : '');
      qs('#worker-elapsed').textContent = task.elapsed !== undefined ? task.elapsed + 's' : '—';
    }
    function setStats(s) {
      var el = qs('#stat-status');
      if (el == null) { return; }
      el.textContent = s.status == null ? '—' : s.status;
      el.className = s.status === 'working' ? 'ok' : s.status === 'crashed' ? 'err' : 'muted';
      qs('#stat-completed').textContent = s.completedCount == null ? 0 : s.completedCount;
      qs('#stat-errors').textContent = s.errorCount == null ? 0 : s.errorCount;
      qs('#stat-ready').textContent = s.readyCount == null ? 0 : s.readyCount;
      qs('#stat-working').textContent = s.workingCount == null ? 0 : s.workingCount;
      qs('#stat-started').textContent = s.startedAt == null ? '—' : s.startedAt;
    }
    function setQueue(items) {
      var el = qs('#queue');
      if (el == null) { return; }
      if (items == null || items.length === 0) {
        el.innerHTML = '<li class="empty">(empty)</li>'; return;
      }
      el.innerHTML = items.map(function (t) {
        return '<li>' + fmtPriority(t.priority) +
          '<strong>' + escape(t.issueId == null ? '—' : t.issueId) + '</strong> · ' +
          escape(t.type) +
          (t.description ? ' <span class="muted">— ' + escape(t.description) + '</span>' : '') +
          '</li>';
      }).join('');
    }
    function setLog(entries) {
      var el = qs('#log');
      if (el == null) { return; }
      if (entries == null || entries.length === 0) {
        el.innerHTML = '<li class="empty">(no entries)</li>'; return;
      }
      el.innerHTML = entries.slice(0, 50).map(function (e) {
        return '<li><span class="muted">' + escape(e.timestamp) + '</span> ' +
          '<span class="pill pN">' + escape(e.component) + '</span>' +
          escape(e.issueId == null ? '-' : e.issueId) + ' · ' + escape(e.message) +
          '</li>';
      }).join('');
    }
    function load() {
      return Promise.all([
        fetch('/api/status').then(function (r) { return r.json(); }),
        fetch('/api/queue').then(function (r) { return r.json(); }),
        fetch('/api/logs').then(function (r) { return r.json(); }),
      ]).then(function (parts) {
        var status = parts[0]; var queue = parts[1]; var logs = parts[2];
        setStartedAt(status.startedAt);
        setStats(status);
        setWorker(status.currentTask);
        setQueue(queue);
        setLog(logs);
      }).catch(function (err) {
        var el = qs('#status-line');
        if (el) { el.textContent = 'error: ' + err.message; el.className = 'err'; }
      });
    }
    return { init: load, refresh: load, setWorker: setWorker };
  })();

  // --------------- Config tab ---------------
  var rqConfig = (function () {
    function renderEnv(refs) {
      var el = qs('#config-env');
      if (el == null) { return; }
      if (refs == null || refs.length === 0) {
        el.innerHTML = '<li class="empty">(none detected)</li>'; return;
      }
      el.innerHTML = refs.map(function (r) {
        return '<li><code>\${' + escape(r.name) + '}</code> — ' +
          (r.set ? '<span class="ok">set</span>' : '<span class="err">not set</span>') +
          '</li>';
      }).join('');
    }
    function setMessage(html, cls) {
      var el = qs('#config-message');
      if (el == null) { return; }
      el.className = cls || ''; el.innerHTML = html;
    }
    function setRestartBanner(restartRequired) {
      var el = qs('#config-restart');
      if (el == null) { return; }
      if (restartRequired == null || restartRequired.length === 0) {
        el.style.display = 'none'; el.innerHTML = ''; return;
      }
      el.style.display = 'block';
      el.innerHTML = 'Restart required for: ' + restartRequired.map(escape).join(', ') +
        '. <button type="button" id="config-restart-btn">Restart now</button>';
      var btn = qs('#config-restart-btn');
      if (btn) {
        btn.addEventListener('click', function () {
          fetch('/api/service/restart', { method: 'POST' })
            .then(function () { setMessage('<span class="ok">restart dispatched</span>'); })
            .catch(function (err) { setMessage('<span class="err">restart failed: ' + escape(err.message) + '</span>'); });
        });
      }
    }
    function load() {
      var loader = qs('#config-loader');
      var form = qs('#config-form');
      if (loader == null || form == null) { return; }
      fetch('/api/config').then(function (r) { return r.json(); }).then(function (data) {
        qs('#config-yaml').value = data.yaml == null ? '' : data.yaml;
        renderEnv(data.envRefs || []);
        loader.style.display = 'none';
        form.style.display = 'block';
      }).catch(function (err) {
        loader.textContent = 'error loading config: ' + err.message;
      });
    }
    function init() {
      if (qs('#config-panel') == null) { return; }
      var validateBtn = qs('#config-validate-btn');
      var saveBtn = qs('#config-save-btn');
      var reloadBtn = qs('#config-reload-btn');
      if (validateBtn) {
        validateBtn.addEventListener('click', function () {
          setMessage('validating…', 'muted');
          var yaml = qs('#config-yaml').value;
          fetch('/api/config/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: yaml,
          }).then(function (r) { return r.json(); }).then(function (data) {
            if (data.ok) {
              setMessage('<span class="ok">valid</span>' +
                (data.warnings && data.warnings.length > 0
                  ? '<br><span class="warn">warnings:</span><ul>' +
                    data.warnings.map(function (w) { return '<li class="warn">' + escape(w) + '</li>'; }).join('') + '</ul>'
                  : ''));
            } else {
              setMessage('<span class="err">invalid</span><ul>' +
                (data.errors || []).map(function (e) { return '<li class="err">' + escape(e) + '</li>'; }).join('') +
                '</ul>');
            }
          }).catch(function (err) {
            setMessage('<span class="err">validate failed: ' + escape(err.message) + '</span>');
          });
        });
      }
      if (saveBtn) {
        saveBtn.addEventListener('click', function () {
          setMessage('saving…', 'muted');
          var yaml = qs('#config-yaml').value;
          fetch('/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain' },
            body: yaml,
          }).then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
            .then(function (res) {
              var data = res.data;
              if (res.ok && data.ok) {
                var applied = data.applied || [];
                setMessage('<span class="ok">saved</span>' +
                  (applied.length > 0 ? '<br>applied: ' + applied.map(escape).join(', ') : ''));
                setRestartBanner(data.restartRequired || []);
                load();
              } else {
                setMessage('<span class="err">save failed</span><ul>' +
                  (data.errors || []).map(function (e) { return '<li class="err">' + escape(e) + '</li>'; }).join('') +
                  '</ul>');
              }
            }).catch(function (err) {
              setMessage('<span class="err">save failed: ' + escape(err.message) + '</span>');
            });
        });
      }
      if (reloadBtn) {
        reloadBtn.addEventListener('click', function () { load(); });
      }
      load();
    }
    return { init: init };
  })();

  // --------------- Skills tab ---------------
  var rqSkills = (function () {
    var currentSkill = null;
    function renderRows(rows) {
      var tbody = qs('#skills-rows');
      if (tbody == null) { return; }
      if (rows == null || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty">(no skills)</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(function (r) {
        var refs = (r.referencedBy || []).map(escape).join(', ');
        return '<tr data-name="' + escape(r.name) + '" style="cursor:pointer;border-top:1px solid var(--border)">' +
          '<td style="padding:6px 8px"><strong>' + escape(r.name) + '</strong></td>' +
          '<td style="padding:6px 8px"><span class="pill pN">' + escape(r.origin) + '</span></td>' +
          '<td style="padding:6px 8px">' + (r.disabled ? '<span class="err">yes</span>' : '<span class="muted">no</span>') + '</td>' +
          '<td style="padding:6px 8px" class="muted">' + (refs.length > 0 ? refs : '—') + '</td>' +
          '</tr>';
      }).join('');
      qsa('tr[data-name]', tbody).forEach(function (row) {
        row.addEventListener('click', function () { openEditor(row.getAttribute('data-name')); });
      });
    }
    function load() {
      var loader = qs('#skills-loader');
      var body = qs('#skills-body');
      if (loader == null || body == null) { return; }
      fetch('/api/skills').then(function (r) { return r.json(); }).then(function (rows) {
        renderRows(rows);
        loader.style.display = 'none';
        body.style.display = 'block';
      }).catch(function (err) {
        loader.textContent = 'error: ' + err.message;
      });
    }
    function openEditor(name) {
      currentSkill = name;
      qs('#skill-editor').style.display = 'block';
      qs('#skill-editor-name').textContent = name;
      qs('#skill-message').innerHTML = '';
      fetch('/api/skills/' + encodeURIComponent(name))
        .then(function (r) { return r.json(); })
        .then(function (data) { qs('#skill-content').value = data.content == null ? '' : data.content; })
        .catch(function (err) {
          qs('#skill-message').innerHTML = '<span class="err">load failed: ' + escape(err.message) + '</span>';
        });
    }
    function init() {
      if (qs('#skills-panel') == null) { return; }
      var saveBtn = qs('#skill-save');
      var deleteBtn = qs('#skill-delete');
      var cancelBtn = qs('#skill-cancel');
      var createBtn = qs('#new-skill-create');
      if (saveBtn) {
        saveBtn.addEventListener('click', function () {
          if (currentSkill === null) { return; }
          var content = qs('#skill-content').value;
          fetch('/api/skills/' + encodeURIComponent(currentSkill), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content }),
          }).then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
            .then(function (res) {
              if (res.ok && res.data.ok) {
                qs('#skill-message').innerHTML = '<span class="ok">saved</span>';
                load();
              } else {
                qs('#skill-message').innerHTML = '<span class="err">' + escape(res.data.error || 'save failed') + '</span>';
              }
            }).catch(function (err) {
              qs('#skill-message').innerHTML = '<span class="err">save failed: ' + escape(err.message) + '</span>';
            });
        });
      }
      if (deleteBtn) {
        deleteBtn.addEventListener('click', function () {
          if (currentSkill === null) { return; }
          fetch('/api/skills/' + encodeURIComponent(currentSkill), { method: 'DELETE' })
            .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
            .then(function (res) {
              if (res.ok && res.data.ok) {
                qs('#skill-message').innerHTML = '<span class="ok">user override removed</span>';
                load();
              } else {
                qs('#skill-message').innerHTML = '<span class="err">' + escape(res.data.message || res.data.error || 'delete failed') + '</span>';
              }
            }).catch(function (err) {
              qs('#skill-message').innerHTML = '<span class="err">delete failed: ' + escape(err.message) + '</span>';
            });
        });
      }
      if (cancelBtn) {
        cancelBtn.addEventListener('click', function () {
          qs('#skill-editor').style.display = 'none';
          currentSkill = null;
        });
      }
      if (createBtn) {
        createBtn.addEventListener('click', function () {
          var name = qs('#new-skill-name').value.trim();
          if (name.length === 0) {
            qs('#new-skill-message').innerHTML = '<span class="err">name required</span>';
            return;
          }
          fetch('/api/skills/' + encodeURIComponent(name), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '# ' + name + '\\n\\n' }),
          }).then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
            .then(function (res) {
              if (res.ok && res.data.ok) {
                qs('#new-skill-message').innerHTML = '<span class="ok">created</span>';
                qs('#new-skill-name').value = '';
                load();
                openEditor(name);
              } else {
                qs('#new-skill-message').innerHTML = '<span class="err">' + escape(res.data.error || 'create failed') + '</span>';
              }
            }).catch(function (err) {
              qs('#new-skill-message').innerHTML = '<span class="err">create failed: ' + escape(err.message) + '</span>';
            });
        });
      }
      load();
    }
    return { init: init };
  })();

  // --------------- Workflow tab ---------------
  var rqWorkflow = (function () {
    var phases = [];
    var skillsList = [];
    function skillOptions(current) {
      var opts = ['<option value="">(none)</option>'].concat(
        skillsList.map(function (s) {
          return '<option value="' + escape(s.name) + '"' + (s.name === current ? ' selected' : '') + '>' +
            escape(s.name) + '</option>';
        }));
      return opts.join('');
    }
    function gridField(label, key, val, idx) {
      return '<div style="display:grid;grid-template-columns:120px 1fr;gap:4px 10px;margin-bottom:4px">' +
        '<label class="muted">' + label + '</label>' +
        '<input type="text" data-idx="' + idx + '" data-key="' + key + '" value="' + escape(val) + '" ' +
        'style="background:var(--bg);color:var(--text);border:1px solid var(--border);padding:4px 6px;font-family:inherit" />' +
        '</div>';
    }
    function gridSelect(label, key, val, idx, options) {
      var opts = options.map(function (o) {
        return '<option value="' + escape(o) + '"' + (o === val ? ' selected' : '') + '>' + escape(o) + '</option>';
      }).join('');
      return '<div style="display:grid;grid-template-columns:120px 1fr;gap:4px 10px;margin-bottom:4px">' +
        '<label class="muted">' + label + '</label>' +
        '<select data-idx="' + idx + '" data-key="' + key + '" ' +
        'style="background:var(--bg);color:var(--text);border:1px solid var(--border);padding:4px 6px;font-family:inherit">' +
        opts + '</select></div>';
    }
    function gridSkill(label, key, val, idx) {
      return '<div style="display:grid;grid-template-columns:120px 1fr;gap:4px 10px;margin-bottom:4px">' +
        '<label class="muted">' + label + '</label>' +
        '<select data-idx="' + idx + '" data-key="' + key + '" ' +
        'style="background:var(--bg);color:var(--text);border:1px solid var(--border);padding:4px 6px;font-family:inherit">' +
        skillOptions(val) + '</select></div>';
    }
    function onFieldChange(evt) {
      var idx = Number(evt.target.getAttribute('data-idx'));
      var key = evt.target.getAttribute('data-key');
      var raw = evt.target.value;
      var phase = phases[idx];
      if (phase == null) { return; }
      if (key === 'priority' || key === 'maxIterations') {
        if (raw === '') { delete phase[key]; }
        else { phase[key] = Number(raw); }
      } else if (key === 'skill' || key === 'onFail' || key === 'rework' || key === 'escalateTo') {
        if (raw === '') { delete phase[key]; }
        else { phase[key] = raw; }
      } else {
        phase[key] = raw;
      }
    }
    function renderPhases() {
      var root = qs('#wf-phases');
      if (root == null) { return; }
      if (phases.length === 0) {
        root.innerHTML = '<p class="empty">no phases defined</p>';
        return;
      }
      root.innerHTML = phases.map(function (p, i) {
        return '<div class="phase-row" data-index="' + i + '" style="border:1px solid var(--border);padding:10px;margin-bottom:8px;border-radius:3px">' +
          '<div class="btn-row" style="justify-content:flex-end;margin-bottom:6px">' +
          '<button type="button" data-up="' + i + '">↑</button>' +
          '<button type="button" data-down="' + i + '">↓</button>' +
          '<button type="button" data-remove="' + i + '">Remove</button>' +
          '</div>' +
          gridField('Name', 'name', p.name, i) +
          gridField('Label', 'label', p.label, i) +
          gridSelect('Type', 'type', p.type, i, ['automated', 'human-gate']) +
          gridSelect('Assign to', 'assignTo', p.assignTo, i, ['ai', 'human']) +
          gridSkill('Skill', 'skill', p.skill || '', i) +
          gridField('Next', 'next', p.next, i) +
          gridField('onFail', 'onFail', p.onFail || '', i) +
          gridField('rework', 'rework', p.rework || '', i) +
          gridField('escalateTo', 'escalateTo', p.escalateTo || '', i) +
          gridField('priority', 'priority', p.priority !== undefined ? String(p.priority) : '', i) +
          gridField('maxIterations', 'maxIterations', p.maxIterations !== undefined ? String(p.maxIterations) : '', i) +
          '</div>';
      }).join('');
      qsa('input,select', root).forEach(function (el) { el.addEventListener('change', onFieldChange); });
      qsa('[data-remove]', root).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var idx = Number(btn.getAttribute('data-remove'));
          phases.splice(idx, 1); renderPhases();
        });
      });
      qsa('[data-up]', root).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var idx = Number(btn.getAttribute('data-up'));
          if (idx > 0) {
            var tmp = phases[idx - 1]; phases[idx - 1] = phases[idx]; phases[idx] = tmp;
            renderPhases();
          }
        });
      });
      qsa('[data-down]', root).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var idx = Number(btn.getAttribute('data-down'));
          if (idx < phases.length - 1) {
            var tmp = phases[idx + 1]; phases[idx + 1] = phases[idx]; phases[idx] = tmp;
            renderPhases();
          }
        });
      });
    }
    function refreshQueueCount() {
      if (qs('#wf-ready') == null) { return; }
      fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
        if (qs('#wf-ready') == null) { return; }
        qs('#wf-ready').textContent = s.readyCount == null ? 0 : s.readyCount;
        qs('#wf-working').textContent = s.workingCount == null ? 0 : s.workingCount;
        var total = (s.readyCount || 0) + (s.workingCount || 0);
        var saveBtn = qs('#wf-save');
        if (saveBtn) {
          saveBtn.disabled = total > 0;
          saveBtn.title = total > 0 ? 'stop orchestrator and drain the queue first' : '';
        }
      }).catch(function () { /* leave counts as-is on transient failure */ });
    }
    function load() {
      var loader = qs('#workflow-loader');
      var body = qs('#workflow-body');
      if (loader == null || body == null) { return; }
      Promise.all([
        fetch('/api/workflow').then(function (r) { return r.json(); }),
        fetch('/api/skills').then(function (r) { return r.json(); }),
      ]).then(function (parts) {
        var wf = parts[0]; var skills = parts[1];
        phases = wf.phases || [];
        skillsList = skills || [];
        qs('#workflow-skills').innerHTML = 'skills available: ' +
          skillsList.map(function (s) { return escape(s.name) + (s.disabled ? ' (disabled)' : ''); }).join(', ');
        renderPhases();
        refreshQueueCount();
        loader.style.display = 'none';
        body.style.display = 'block';
      }).catch(function (err) {
        loader.textContent = 'error: ' + err.message;
      });
    }
    function showResult(data) {
      var msg = qs('#wf-message');
      if (msg == null) { return; }
      var errs = (data.errors || []).map(function (e) { return '<li class="err">' + escape(e) + '</li>'; }).join('');
      var warns = (data.warnings || []).map(function (w) { return '<li class="warn">' + escape(w) + '</li>'; }).join('');
      if (data.ok) {
        msg.innerHTML = '<span class="ok">valid</span>' + (warns ? '<ul>' + warns + '</ul>' : '');
      } else {
        msg.innerHTML = '<span class="err">invalid</span><ul>' + errs + warns + '</ul>';
      }
    }
    function init() {
      if (qs('#workflow-panel') == null) { return; }
      var addBtn = qs('#wf-add');
      var validateBtn = qs('#wf-validate');
      var saveBtn = qs('#wf-save');
      if (addBtn) {
        addBtn.addEventListener('click', function () {
          phases.push({
            name: 'new-phase',
            label: 'New Phase',
            type: 'automated',
            skill: (skillsList[0] && skillsList[0].name) || 'coder',
            next: 'done',
            assignTo: 'ai',
          });
          renderPhases();
        });
      }
      if (validateBtn) {
        validateBtn.addEventListener('click', function () {
          qs('#wf-message').innerHTML = 'validating…';
          fetch('/api/workflow/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phases: phases }),
          }).then(function (r) { return r.json(); }).then(showResult).catch(function (err) {
            qs('#wf-message').innerHTML = '<span class="err">validate failed: ' + escape(err.message) + '</span>';
          });
        });
      }
      if (saveBtn) {
        saveBtn.addEventListener('click', function () {
          qs('#wf-message').innerHTML = 'saving…';
          fetch('/api/workflow', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phases: phases }),
          }).then(function (r) { return r.json().then(function (data) { return { status: r.status, ok: r.ok, data: data }; }); })
            .then(function (res) {
              var data = res.data;
              var msg = qs('#wf-message');
              if (msg == null) { return; }
              if (res.status === 409) {
                msg.innerHTML = '<span class="err">' + escape(data.message || 'open tasks present') + '</span> ' +
                  '<button type="button" id="wf-stop-service">Stop service</button>';
                var btn = qs('#wf-stop-service');
                if (btn) {
                  btn.addEventListener('click', function () {
                    fetch('/api/service/stop', { method: 'POST' })
                      .then(function () { qs('#wf-message').innerHTML = '<span class="ok">stop dispatched</span>'; })
                      .catch(function (err) { qs('#wf-message').innerHTML = '<span class="err">stop failed: ' + escape(err.message) + '</span>'; });
                  });
                }
                return;
              }
              if (res.ok && data.ok) {
                msg.innerHTML = '<span class="ok">saved</span>' +
                  ((data.applied || []).length > 0 ? ' — applied: ' + data.applied.map(escape).join(', ') : '') +
                  ((data.restartRequired || []).length > 0
                    ? '<br><span class="warn">restart required: ' + data.restartRequired.map(escape).join(', ') + '</span>'
                    : '');
                load();
                return;
              }
              showResult(data);
            }).catch(function (err) {
              var msg = qs('#wf-message');
              if (msg) { msg.innerHTML = '<span class="err">save failed: ' + escape(err.message) + '</span>'; }
            });
        });
      }
      load();
    }
    return { init: init, refresh: refreshQueueCount };
  })();

  // --------------- htmx lifecycle ---------------
  // After each swap, run the init for whichever tab just landed.
  var INIT = {
    status: rqStatus.init,
    config: rqConfig.init,
    skills: rqSkills.init,
    workflow: rqWorkflow.init,
  };
  function activeTabKey() {
    var btn = qs('nav.tabs button.active');
    return btn ? btn.getAttribute('data-tab') : null;
  }
  document.body.addEventListener('htmx:afterSettle', function (evt) {
    if (evt.target && evt.target.id !== 'main') { return; }
    var key = activeTabKey();
    if (key && INIT[key]) { INIT[key](); }
  });

  // --------------- SSE ---------------
  try {
    var sse = new EventSource('/api/events');
    sse.addEventListener('open', function () {
      var el = qs('#status-line');
      if (el) { el.textContent = 'connected'; el.className = 'ok'; }
    });
    sse.addEventListener('error', function () {
      var el = qs('#status-line');
      if (el) { el.textContent = 'reconnecting...'; el.className = 'warn'; }
    });
    sse.addEventListener('worker:started', function (e) {
      var d = JSON.parse(e.data);
      if (qs('#worker-status') == null) { return; }
      rqStatus.setWorker({ status: 'working', issueId: d.issueId, type: d.taskType, elapsed: 0 });
    });
    sse.addEventListener('worker:heartbeat', function (e) {
      var d = JSON.parse(e.data);
      var elapsed = qs('#worker-elapsed');
      var hb = qs('#worker-heartbeat');
      if (elapsed) { elapsed.textContent = d.elapsed + 's'; }
      if (hb) { hb.textContent = 'cpu ' + d.cpuPercent + '%, rss ' + d.rssKb + 'KB, idle ' + d.idleSeconds + 's'; }
    });
    sse.addEventListener('worker:completed', function () {
      rqStatus.setWorker(null);
      if (activeTabKey() === 'status') { rqStatus.refresh(); }
    });
    sse.addEventListener('queue:changed', function () {
      if (activeTabKey() === 'status') { rqStatus.refresh(); }
      if (activeTabKey() === 'workflow') { rqWorkflow.refresh(); }
    });
    sse.addEventListener('orchestrator:status', function () {
      if (activeTabKey() === 'status') { rqStatus.refresh(); }
    });
  } catch (err) { /* SSE unavailable — dashboard still functions via manual refresh */ }

  // --------------- Initial tab ---------------
  // The server renders one tab's content into #main on first load. htmx
  // hasn't fired afterSettle for that, so run its init directly once the
  // DOM is ready.
  function runInitialInit() {
    var key = activeTabKey();
    if (key && INIT[key]) { INIT[key](); }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runInitialInit);
  } else {
    runInitialInit();
  }
})();
`;

function renderNav(active: NavKey): string {
  return NAV_TABS.map((tab) => {
    const cls = tab.key === active ? "active" : "";
    return `<button class="${cls}" data-tab="${tab.key}" hx-get="${tab.partialPath}" hx-target="#main" hx-swap="innerHTML">${escapeHtml(tab.label)}</button>`;
  }).join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderShell(options: ShellOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Red Queen — Pipeline</title>
<!-- Defense in depth: disable htmx's eval / inline-script execution. The
     dashboard only renders its own backend HTML, so hx-vars expressions
     and server-provided <script> tags are never intentional. All tab
     controllers live in this shell script so they load once on the initial
     HTML parse and are not subject to htmx's script-tag policy. -->
<meta name="htmx-config" content='{"allowEval":false,"allowScriptTags":false,"includeIndicatorStyles":true}' />
<style>${STYLES}</style>
<script src="/assets/htmx.min.js" defer></script>
</head>
<body>
<header>
  <img class="logo" src="/assets/brand/logo.png" alt="Red Queen" />
  <h1>Red Queen</h1>
  <span class="tagline">Named for the AI that ran The Hive. Yours runs your SDLC.</span>
  <span id="status-line" class="muted">connecting...</span>
  <span class="status" id="uptime"></span>
</header>
<nav class="tabs">${renderNav(options.active)}</nav>
<main id="main">${options.content}</main>
<script>
${CONTROLLER_JS}
</script>
</body>
</html>
`;
}
