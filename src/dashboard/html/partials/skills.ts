export function renderSkillsPartial(): string {
  return `<section id="skills-panel" class="span2">
    <h2>Skills</h2>
    <div id="skills-loader" class="muted">loading…</div>
    <div id="skills-body" style="display:none">
      <table id="skills-table" style="width:100%;border-collapse:collapse;margin-bottom:12px">
        <thead>
          <tr style="text-align:left;color:var(--muted);font-size:11px;letter-spacing:0.08em;text-transform:uppercase">
            <th style="padding:6px 8px">Name</th>
            <th style="padding:6px 8px">Origin</th>
            <th style="padding:6px 8px">Disabled</th>
            <th style="padding:6px 8px">Referenced by</th>
          </tr>
        </thead>
        <tbody id="skills-rows"></tbody>
      </table>
      <div id="skill-editor" style="display:none">
        <h3 style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted)">
          Editing: <span id="skill-editor-name" class="ok"></span>
        </h3>
        <textarea id="skill-content" style="width:100%;height:320px;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px;font-family:inherit;font-size:12px;" spellcheck="false"></textarea>
        <div class="btn-row" style="margin-top:8px">
          <button id="skill-save" type="button">Save user override</button>
          <button id="skill-delete" type="button">Delete user override</button>
          <button id="skill-cancel" type="button">Close</button>
        </div>
        <div id="skill-message" style="margin-top:8px"></div>
      </div>
      <h3 style="margin-top:18px;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted)">Create user skill</h3>
      <div class="btn-row" style="gap:8px">
        <input id="new-skill-name" placeholder="skill-name" style="background:var(--bg);color:var(--text);border:1px solid var(--border);padding:6px 8px;font-family:inherit" />
        <button id="new-skill-create" type="button">Create</button>
      </div>
      <div id="new-skill-message" class="muted" style="margin-top:6px"></div>
    </div>
  </section>
<script>
  (function () {
    if (window.__rqSkillsInit) { return; }
    window.__rqSkillsInit = true;
    const qs = (s) => document.querySelector(s);
    const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]);
    let currentSkill = null;
    async function load() {
      try {
        const res = await fetch('/api/skills');
        const rows = await res.json();
        renderRows(rows);
        qs('#skills-loader').style.display = 'none';
        qs('#skills-body').style.display = 'block';
      } catch (err) {
        qs('#skills-loader').textContent = 'error: ' + err.message;
      }
    }
    function renderRows(rows) {
      const tbody = qs('#skills-rows');
      if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty">(no skills)</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map((r) => {
        const refs = (r.referencedBy || []).map(escape).join(', ');
        return '<tr data-name="' + escape(r.name) + '" style="cursor:pointer;border-top:1px solid var(--border)">' +
          '<td style="padding:6px 8px"><strong>' + escape(r.name) + '</strong></td>' +
          '<td style="padding:6px 8px"><span class="pill pN">' + escape(r.origin) + '</span></td>' +
          '<td style="padding:6px 8px">' + (r.disabled ? '<span class="err">yes</span>' : '<span class="muted">no</span>') + '</td>' +
          '<td style="padding:6px 8px" class="muted">' + (refs.length > 0 ? refs : '—') + '</td>' +
          '</tr>';
      }).join('');
      tbody.querySelectorAll('tr[data-name]').forEach((row) => {
        row.addEventListener('click', () => { openEditor(row.getAttribute('data-name')); });
      });
    }
    async function openEditor(name) {
      currentSkill = name;
      qs('#skill-editor').style.display = 'block';
      qs('#skill-editor-name').textContent = name;
      qs('#skill-message').innerHTML = '';
      try {
        const res = await fetch('/api/skills/' + encodeURIComponent(name));
        const data = await res.json();
        qs('#skill-content').value = data.content ?? '';
      } catch (err) {
        qs('#skill-message').innerHTML = '<span class="err">load failed: ' + escape(err.message) + '</span>';
      }
    }
    qs('#skill-save').addEventListener('click', async () => {
      if (currentSkill === null) { return; }
      const content = qs('#skill-content').value;
      try {
        const res = await fetch('/api/skills/' + encodeURIComponent(currentSkill), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          qs('#skill-message').innerHTML = '<span class="ok">saved</span>';
          load();
        } else {
          qs('#skill-message').innerHTML = '<span class="err">' + escape(data.error || 'save failed') + '</span>';
        }
      } catch (err) {
        qs('#skill-message').innerHTML = '<span class="err">save failed: ' + escape(err.message) + '</span>';
      }
    });
    qs('#skill-delete').addEventListener('click', async () => {
      if (currentSkill === null) { return; }
      try {
        const res = await fetch('/api/skills/' + encodeURIComponent(currentSkill), { method: 'DELETE' });
        const data = await res.json();
        if (res.ok && data.ok) {
          qs('#skill-message').innerHTML = '<span class="ok">user override removed</span>';
          load();
        } else {
          qs('#skill-message').innerHTML = '<span class="err">' + escape(data.message || data.error || 'delete failed') + '</span>';
        }
      } catch (err) {
        qs('#skill-message').innerHTML = '<span class="err">delete failed: ' + escape(err.message) + '</span>';
      }
    });
    qs('#skill-cancel').addEventListener('click', () => {
      qs('#skill-editor').style.display = 'none';
      currentSkill = null;
    });
    qs('#new-skill-create').addEventListener('click', async () => {
      const name = qs('#new-skill-name').value.trim();
      if (name.length === 0) {
        qs('#new-skill-message').innerHTML = '<span class="err">name required</span>';
        return;
      }
      try {
        const res = await fetch('/api/skills/' + encodeURIComponent(name), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: '# ' + name + '\\n\\n' }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          qs('#new-skill-message').innerHTML = '<span class="ok">created</span>';
          qs('#new-skill-name').value = '';
          load();
          openEditor(name);
        } else {
          qs('#new-skill-message').innerHTML = '<span class="err">' + escape(data.error || 'create failed') + '</span>';
        }
      } catch (err) {
        qs('#new-skill-message').innerHTML = '<span class="err">create failed: ' + escape(err.message) + '</span>';
      }
    });
    load();
  })();
</script>`;
}
