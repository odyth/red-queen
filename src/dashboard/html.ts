export function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Red Queen — Pipeline</title>
<style>
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
  main {
    display: grid;
    grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);
    gap: 12px;
    padding: 12px 20px 40px;
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
</style>
</head>
<body>
<header>
  <img class="logo" src="/assets/brand/logo.png" alt="Red Queen" />
  <h1>Red Queen</h1>
  <span class="tagline">Named for the AI that ran The Hive. Yours runs your SDLC.</span>
  <span id="status-line" class="muted">connecting...</span>
  <span class="status" id="uptime"></span>
</header>
<main>
  <section>
    <h2>Worker</h2>
    <dl class="kv" id="worker">
      <dt>Status</dt><dd id="worker-status" class="muted">idle</dd>
      <dt>Issue</dt><dd id="worker-issue" class="muted">—</dd>
      <dt>Task</dt><dd id="worker-task" class="muted">—</dd>
      <dt>Elapsed</dt><dd id="worker-elapsed" class="muted">—</dd>
      <dt>Heartbeat</dt><dd id="worker-heartbeat" class="muted">—</dd>
    </dl>
  </section>
  <section>
    <h2>Stats</h2>
    <dl class="kv">
      <dt>Status</dt><dd id="stat-status" class="muted">—</dd>
      <dt>Completed</dt><dd id="stat-completed">0</dd>
      <dt>Errors</dt><dd id="stat-errors">0</dd>
      <dt>Ready</dt><dd id="stat-ready">0</dd>
      <dt>Working</dt><dd id="stat-working">0</dd>
      <dt>Started</dt><dd id="stat-started" class="muted">—</dd>
    </dl>
  </section>
  <section class="span2">
    <h2>Queue (ready)</h2>
    <ul id="queue"><li class="empty">(empty)</li></ul>
  </section>
  <section class="span2">
    <h2>Recent Log</h2>
    <ul id="log" class="log"><li class="empty">(no entries)</li></ul>
  </section>
</main>
<script>
  const qs = (s) => document.querySelector(s);
  const fmtPriority = (p) => {
    if (p === 0) return '<span class="pill p0">P0</span>';
    if (p === 1) return '<span class="pill p1">P1</span>';
    return '<span class="pill pN">P' + p + '</span>';
  };
  const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]);

  function setWorker(task) {
    if (!task || task.status !== 'working') {
      qs('#worker-status').textContent = 'idle';
      qs('#worker-status').className = 'muted';
      qs('#worker-issue').textContent = '—';
      qs('#worker-task').textContent = '—';
      qs('#worker-elapsed').textContent = '—';
      qs('#worker-heartbeat').textContent = '—';
      return;
    }
    qs('#worker-status').textContent = 'working';
    qs('#worker-status').className = 'ok';
    qs('#worker-issue').textContent = task.issueId ?? '—';
    qs('#worker-task').textContent = task.type + (task.description ? ' — ' + task.description : '');
    qs('#worker-elapsed').textContent = task.elapsed !== undefined ? task.elapsed + 's' : '—';
  }

  function setStats(s) {
    qs('#stat-status').textContent = s.status ?? '—';
    qs('#stat-status').className = s.status === 'working' ? 'ok' : s.status === 'crashed' ? 'err' : 'muted';
    qs('#stat-completed').textContent = s.completedCount ?? 0;
    qs('#stat-errors').textContent = s.errorCount ?? 0;
    qs('#stat-ready').textContent = s.readyCount ?? 0;
    qs('#stat-working').textContent = s.workingCount ?? 0;
    qs('#stat-started').textContent = s.startedAt ?? '—';
  }

  function setQueue(items) {
    const el = qs('#queue');
    if (!items || items.length === 0) {
      el.innerHTML = '<li class="empty">(empty)</li>';
      return;
    }
    el.innerHTML = items.map((t) =>
      '<li>' + fmtPriority(t.priority) +
      '<strong>' + escape(t.issueId ?? '—') + '</strong> · ' +
      escape(t.type) +
      (t.description ? ' <span class="muted">— ' + escape(t.description) + '</span>' : '') +
      '</li>'
    ).join('');
  }

  function setLog(entries) {
    const el = qs('#log');
    if (!entries || entries.length === 0) {
      el.innerHTML = '<li class="empty">(no entries)</li>';
      return;
    }
    el.innerHTML = entries.slice(0, 50).map((e) =>
      '<li><span class="muted">' + escape(e.timestamp) + '</span> ' +
      '<span class="pill pN">' + escape(e.component) + '</span>' +
      escape(e.issueId ?? '-') + ' · ' + escape(e.message) +
      '</li>'
    ).join('');
  }

  async function loadInitial() {
    try {
      const [statusRes, queueRes, logsRes] = await Promise.all([
        fetch('/api/status'),
        fetch('/api/queue'),
        fetch('/api/logs'),
      ]);
      const status = await statusRes.json();
      const queue = await queueRes.json();
      const logs = await logsRes.json();
      setStats(status);
      setWorker(status.currentTask);
      setQueue(queue);
      setLog(logs);
    } catch (err) {
      qs('#status-line').textContent = 'error: ' + err.message;
      qs('#status-line').className = 'err';
    }
  }

  const sse = new EventSource('/api/events');
  sse.addEventListener('open', () => {
    qs('#status-line').textContent = 'connected';
    qs('#status-line').className = 'ok';
  });
  sse.addEventListener('error', () => {
    qs('#status-line').textContent = 'reconnecting...';
    qs('#status-line').className = 'warn';
  });
  sse.addEventListener('worker:started', (e) => {
    const d = JSON.parse(e.data);
    setWorker({ status: 'working', issueId: d.issueId, type: d.taskType, elapsed: 0 });
  });
  sse.addEventListener('worker:heartbeat', (e) => {
    const d = JSON.parse(e.data);
    qs('#worker-elapsed').textContent = d.elapsed + 's';
    qs('#worker-heartbeat').textContent =
      'cpu ' + d.cpuPercent + '%, rss ' + d.rssKb + 'KB, idle ' + d.idleSeconds + 's';
  });
  sse.addEventListener('worker:completed', (e) => {
    setWorker(null);
    loadInitial();
  });
  sse.addEventListener('queue:changed', (e) => {
    loadInitial();
  });
  sse.addEventListener('orchestrator:status', (e) => {
    loadInitial();
  });

  loadInitial();
  setInterval(() => {
    const started = qs('#stat-started').textContent;
    if (started && started !== '—') {
      const diff = Math.round((Date.now() - new Date(started).getTime()) / 1000);
      qs('#uptime').textContent = 'uptime ' + diff + 's';
    }
  }, 1000);
</script>
</body>
</html>
`;
}
