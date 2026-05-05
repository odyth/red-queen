export function renderWorkflowPartial(): string {
  return `<section id="workflow-panel" class="span2">
    <h2>Workflow</h2>
    <div id="workflow-loader" class="muted">loading…</div>
    <div id="workflow-body" style="display:none">
      <div id="workflow-queue" class="muted" style="margin-bottom:10px">
        open tasks: ready=<span id="wf-ready">0</span> working=<span id="wf-working">0</span>
      </div>
      <div id="workflow-skills" class="muted" style="margin-bottom:10px"></div>
      <div class="btn-row" style="margin-bottom:10px">
        <button id="wf-add" type="button">Add phase</button>
        <button id="wf-validate" type="button">Validate</button>
        <button id="wf-save" type="button">Save</button>
      </div>
      <div id="wf-phases"></div>
      <div id="wf-message" style="margin-top:8px"></div>
    </div>
  </section>
<script>
  (function () {
    if (window.__rqWorkflowInit) { return; }
    window.__rqWorkflowInit = true;
    const qs = (s) => document.querySelector(s);
    const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]);
    let phases = [];
    let skillsList = [];
    async function load() {
      try {
        const [wfRes, skillsRes] = await Promise.all([
          fetch('/api/workflow'),
          fetch('/api/skills'),
        ]);
        const wf = await wfRes.json();
        const skills = await skillsRes.json();
        phases = wf.phases || [];
        skillsList = skills || [];
        qs('#workflow-skills').innerHTML = 'skills available: ' +
          skillsList.map((s) => escape(s.name) + (s.disabled ? ' (disabled)' : '')).join(', ');
        renderPhases();
        refreshQueueCount();
        qs('#workflow-loader').style.display = 'none';
        qs('#workflow-body').style.display = 'block';
      } catch (err) {
        qs('#workflow-loader').textContent = 'error: ' + err.message;
      }
    }
    async function refreshQueueCount() {
      try {
        const res = await fetch('/api/status');
        const s = await res.json();
        qs('#wf-ready').textContent = s.readyCount ?? 0;
        qs('#wf-working').textContent = s.workingCount ?? 0;
        const total = (s.readyCount ?? 0) + (s.workingCount ?? 0);
        qs('#wf-save').disabled = total > 0;
        qs('#wf-save').title = total > 0 ? 'stop orchestrator and drain the queue first' : '';
      } catch (err) {
        // leave counts as-is on transient failure
      }
    }
    function skillOptions(current) {
      const opts = ['<option value="">(none)</option>'].concat(
        skillsList.map((s) =>
          '<option value="' + escape(s.name) + '"' + (s.name === current ? ' selected' : '') + '>' +
          escape(s.name) + '</option>'
        ));
      return opts.join('');
    }
    function renderPhases() {
      const root = qs('#wf-phases');
      if (phases.length === 0) {
        root.innerHTML = '<p class="empty">no phases defined</p>';
        return;
      }
      root.innerHTML = phases.map((p, i) =>
        '<div class="phase-row" data-index="' + i + '" style="border:1px solid var(--border);padding:10px;margin-bottom:8px;border-radius:3px">' +
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
        '</div>'
      ).join('');
      root.querySelectorAll('input,select').forEach((el) => {
        el.addEventListener('change', onFieldChange);
      });
      root.querySelectorAll('[data-remove]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-remove'));
          phases.splice(idx, 1);
          renderPhases();
        });
      });
      root.querySelectorAll('[data-up]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-up'));
          if (idx > 0) {
            const tmp = phases[idx - 1];
            phases[idx - 1] = phases[idx];
            phases[idx] = tmp;
            renderPhases();
          }
        });
      });
      root.querySelectorAll('[data-down]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-down'));
          if (idx < phases.length - 1) {
            const tmp = phases[idx + 1];
            phases[idx + 1] = phases[idx];
            phases[idx] = tmp;
            renderPhases();
          }
        });
      });
    }
    function gridField(label, key, val, idx) {
      return '<div style="display:grid;grid-template-columns:120px 1fr;gap:4px 10px;margin-bottom:4px">' +
        '<label class="muted">' + label + '</label>' +
        '<input type="text" data-idx="' + idx + '" data-key="' + key + '" value="' + escape(val) + '" ' +
        'style="background:var(--bg);color:var(--text);border:1px solid var(--border);padding:4px 6px;font-family:inherit" />' +
        '</div>';
    }
    function gridSelect(label, key, val, idx, options) {
      const opts = options.map((o) =>
        '<option value="' + escape(o) + '"' + (o === val ? ' selected' : '') + '>' + escape(o) + '</option>'
      ).join('');
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
      const idx = Number(evt.target.getAttribute('data-idx'));
      const key = evt.target.getAttribute('data-key');
      const raw = evt.target.value;
      const phase = phases[idx];
      if (!phase) { return; }
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
    qs('#wf-add').addEventListener('click', () => {
      phases.push({
        name: 'new-phase',
        label: 'New Phase',
        type: 'automated',
        skill: skillsList[0]?.name || 'coder',
        next: 'done',
        assignTo: 'ai',
      });
      renderPhases();
    });
    qs('#wf-validate').addEventListener('click', async () => {
      qs('#wf-message').innerHTML = 'validating…';
      try {
        const res = await fetch('/api/workflow/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phases }),
        });
        const data = await res.json();
        showResult(data);
      } catch (err) {
        qs('#wf-message').innerHTML = '<span class="err">validate failed: ' + escape(err.message) + '</span>';
      }
    });
    qs('#wf-save').addEventListener('click', async () => {
      qs('#wf-message').innerHTML = 'saving…';
      try {
        const res = await fetch('/api/workflow', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phases }),
        });
        const data = await res.json();
        if (res.status === 409) {
          qs('#wf-message').innerHTML =
            '<span class="err">' + escape(data.message || 'open tasks present') + '</span> ' +
            '<button type="button" id="wf-stop-service">Stop service</button>';
          const btn = qs('#wf-stop-service');
          if (btn) {
            btn.addEventListener('click', async () => {
              try {
                await fetch('/api/service/stop', { method: 'POST' });
                qs('#wf-message').innerHTML = '<span class="ok">stop dispatched</span>';
              } catch (err) {
                qs('#wf-message').innerHTML = '<span class="err">stop failed: ' + escape(err.message) + '</span>';
              }
            });
          }
          return;
        }
        if (res.ok && data.ok) {
          qs('#wf-message').innerHTML = '<span class="ok">saved</span>' +
            ((data.applied || []).length > 0 ? ' — applied: ' + data.applied.map(escape).join(', ') : '') +
            ((data.restartRequired || []).length > 0
              ? '<br><span class="warn">restart required: ' + data.restartRequired.map(escape).join(', ') + '</span>'
              : '');
          load();
          return;
        }
        showResult(data);
      } catch (err) {
        qs('#wf-message').innerHTML = '<span class="err">save failed: ' + escape(err.message) + '</span>';
      }
    });
    function showResult(data) {
      const errs = (data.errors || []).map((e) => '<li class="err">' + escape(e) + '</li>').join('');
      const warns = (data.warnings || []).map((w) => '<li class="warn">' + escape(w) + '</li>').join('');
      if (data.ok) {
        qs('#wf-message').innerHTML = '<span class="ok">valid</span>' +
          (warns ? '<ul>' + warns + '</ul>' : '');
      } else {
        qs('#wf-message').innerHTML = '<span class="err">invalid</span><ul>' + errs + warns + '</ul>';
      }
    }
    try {
      const sse = new EventSource('/api/events');
      sse.addEventListener('queue:changed', refreshQueueCount);
    } catch (err) {
      // SSE unavailable — polling fallback below is enough
    }
    setInterval(refreshQueueCount, 5000);
    load();
  })();
</script>`;
}
