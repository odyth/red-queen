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
  </section>`;
}
