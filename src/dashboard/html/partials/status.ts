export function renderStatusPartial(): string {
  return `<section>
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
<script>
  (function () {
    if (window.__rqStatusInit) { return; }
    window.__rqStatusInit = true;
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
    sse.addEventListener('worker:completed', () => {
      setWorker(null);
      loadInitial();
    });
    sse.addEventListener('queue:changed', () => {
      loadInitial();
    });
    sse.addEventListener('orchestrator:status', () => {
      loadInitial();
    });

    loadInitial();
    setInterval(() => {
      const started = qs('#stat-started')?.textContent;
      if (started && started !== '—') {
        const diff = Math.round((Date.now() - new Date(started).getTime()) / 1000);
        const uptime = qs('#uptime');
        if (uptime) { uptime.textContent = 'uptime ' + diff + 's'; }
      }
    }, 1000);
  })();
</script>`;
}
