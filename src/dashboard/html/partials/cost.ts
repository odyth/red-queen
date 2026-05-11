export function renderCostPartial(): string {
  return `<section class="span2">
    <h2>Cost</h2>
    <div id="cost-disabled" class="empty" style="display:none">
      Cost tracking is disabled. Set <code>pipeline.cost.enabled: true</code> in redqueen.yaml to enable.
    </div>
    <div id="cost-body">
      <dl class="kv" style="margin-bottom:12px">
        <dt>Model</dt><dd id="cost-model" class="muted">—</dd>
        <dt>Total (all tickets)</dt><dd id="cost-total" class="muted">—</dd>
        <dt>Updated</dt><dd id="cost-updated" class="muted">—</dd>
      </dl>
      <table id="cost-table" style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="text-align:left;border-bottom:1px solid var(--border)">
            <th style="padding:6px 8px">Issue</th>
            <th style="padding:6px 8px;text-align:right">Runs</th>
            <th style="padding:6px 8px;text-align:right">Total cost</th>
            <th style="padding:6px 8px">Updated</th>
          </tr>
        </thead>
        <tbody id="cost-rows"><tr><td colspan="4" class="empty">loading…</td></tr></tbody>
      </table>
    </div>
  </section>`;
}
