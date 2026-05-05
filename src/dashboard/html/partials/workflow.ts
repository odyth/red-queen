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
  </section>`;
}
