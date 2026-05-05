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
  </section>`;
}
