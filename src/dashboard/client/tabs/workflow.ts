import { api } from "../api.js";
import { escapeHtml, qs, qsa } from "../dom.js";
import type {
  PhaseDefinition,
  SkillEntry,
  WorkflowPutResponse,
  WorkflowValidateResponse,
} from "../../shared/api-types.js";

let phases: PhaseDefinition[] = [];
let skillsList: SkillEntry[] = [];

function skillOptions(current: string): string {
  const opts = [
    '<option value="">(none)</option>',
    ...skillsList.map(
      (s) =>
        `<option value="${escapeHtml(s.name)}"${s.name === current ? " selected" : ""}>${escapeHtml(s.name)}</option>`,
    ),
  ];
  return opts.join("");
}

function gridField(label: string, key: string, val: string, idx: number): string {
  return (
    '<div style="display:grid;grid-template-columns:120px 1fr;gap:4px 10px;margin-bottom:4px">' +
    `<label class="muted">${label}</label>` +
    `<input type="text" data-idx="${String(idx)}" data-key="${key}" value="${escapeHtml(val)}" ` +
    'style="background:var(--bg);color:var(--text);border:1px solid var(--border);padding:4px 6px;font-family:inherit" />' +
    "</div>"
  );
}

function gridSelect(
  label: string,
  key: string,
  val: string,
  idx: number,
  options: string[],
): string {
  const opts = options
    .map(
      (o) =>
        `<option value="${escapeHtml(o)}"${o === val ? " selected" : ""}>${escapeHtml(o)}</option>`,
    )
    .join("");
  return (
    '<div style="display:grid;grid-template-columns:120px 1fr;gap:4px 10px;margin-bottom:4px">' +
    `<label class="muted">${label}</label>` +
    `<select data-idx="${String(idx)}" data-key="${key}" ` +
    'style="background:var(--bg);color:var(--text);border:1px solid var(--border);padding:4px 6px;font-family:inherit">' +
    `${opts}</select></div>`
  );
}

function gridSkill(label: string, key: string, val: string, idx: number): string {
  return (
    '<div style="display:grid;grid-template-columns:120px 1fr;gap:4px 10px;margin-bottom:4px">' +
    `<label class="muted">${label}</label>` +
    `<select data-idx="${String(idx)}" data-key="${key}" ` +
    'style="background:var(--bg);color:var(--text);border:1px solid var(--border);padding:4px 6px;font-family:inherit">' +
    `${skillOptions(val)}</select></div>`
  );
}

type PhaseKey = keyof PhaseDefinition;

function applyNumericField(
  phase: PhaseDefinition,
  key: "priority" | "maxIterations",
  raw: string,
): void {
  if (raw === "") {
    if (key === "priority") {
      phase.priority = undefined;
    } else {
      phase.maxIterations = undefined;
    }
    return;
  }
  phase[key] = Number(raw);
}

function applyOptionalStringField(
  phase: PhaseDefinition,
  key: "skill" | "onFail" | "rework" | "escalateTo",
  raw: string,
): void {
  if (raw === "") {
    phase[key] = undefined;
  } else {
    phase[key] = raw;
  }
}

function onFieldChange(evt: Event): void {
  const target = evt.target;
  if (
    target === null ||
    (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement))
  ) {
    return;
  }
  const idx = Number(target.getAttribute("data-idx"));
  const key = target.getAttribute("data-key") as PhaseKey | null;
  if (key === null) {
    return;
  }
  const raw = target.value;
  const phase = phases[idx];
  if (phase === undefined) {
    return;
  }
  if (key === "priority" || key === "maxIterations") {
    applyNumericField(phase, key, raw);
  } else if (key === "skill" || key === "onFail" || key === "rework" || key === "escalateTo") {
    applyOptionalStringField(phase, key, raw);
  } else if (key === "type") {
    phase.type = raw as PhaseDefinition["type"];
  } else if (key === "assignTo") {
    phase.assignTo = raw as PhaseDefinition["assignTo"];
  } else if (key === "name" || key === "label") {
    phase[key] = raw;
  } else {
    // key is "next" (only remaining member of PhaseKey)
    phase.next = raw;
  }
}

function renderPhases(): void {
  const root = qs<HTMLElement>("#wf-phases");
  if (root === null) {
    return;
  }
  if (phases.length === 0) {
    root.innerHTML = '<p class="empty">no phases defined</p>';
    return;
  }
  root.innerHTML = phases
    .map((p, i) => {
      return (
        `<div class="phase-row" data-index="${String(i)}" style="border:1px solid var(--border);padding:10px;margin-bottom:8px;border-radius:3px">` +
        '<div class="btn-row" style="justify-content:flex-end;margin-bottom:6px">' +
        `<button type="button" data-up="${String(i)}">↑</button>` +
        `<button type="button" data-down="${String(i)}">↓</button>` +
        `<button type="button" data-remove="${String(i)}">Remove</button>` +
        "</div>" +
        gridField("Name", "name", p.name, i) +
        gridField("Label", "label", p.label, i) +
        gridSelect("Type", "type", p.type, i, ["automated", "human-gate"]) +
        gridSelect("Assign to", "assignTo", p.assignTo, i, ["ai", "human"]) +
        gridSkill("Skill", "skill", p.skill ?? "", i) +
        gridField("Next", "next", p.next, i) +
        gridField("onFail", "onFail", p.onFail ?? "", i) +
        gridField("rework", "rework", p.rework ?? "", i) +
        gridField("escalateTo", "escalateTo", p.escalateTo ?? "", i) +
        gridField("priority", "priority", p.priority !== undefined ? String(p.priority) : "", i) +
        gridField(
          "maxIterations",
          "maxIterations",
          p.maxIterations !== undefined ? String(p.maxIterations) : "",
          i,
        ) +
        "</div>"
      );
    })
    .join("");
  qsa<HTMLInputElement | HTMLSelectElement>("input,select", root).forEach((el) => {
    el.addEventListener("change", onFieldChange);
  });
  qsa<HTMLElement>("[data-remove]", root).forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-remove"));
      phases.splice(idx, 1);
      renderPhases();
    });
  });
  qsa<HTMLElement>("[data-up]", root).forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-up"));
      if (idx > 0) {
        const prev = phases[idx - 1];
        const curr = phases[idx];
        if (prev !== undefined && curr !== undefined) {
          phases[idx - 1] = curr;
          phases[idx] = prev;
          renderPhases();
        }
      }
    });
  });
  qsa<HTMLElement>("[data-down]", root).forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-down"));
      if (idx < phases.length - 1) {
        const curr = phases[idx];
        const next = phases[idx + 1];
        if (curr !== undefined && next !== undefined) {
          phases[idx + 1] = curr;
          phases[idx] = next;
          renderPhases();
        }
      }
    });
  });
}

export function refreshQueueCount(): void {
  if (qs("#wf-ready") === null) {
    return;
  }
  api
    .getStatus()
    .then((s) => {
      const ready = qs("#wf-ready");
      const working = qs("#wf-working");
      if (ready === null || working === null) {
        return;
      }
      ready.textContent = String(s.readyCount);
      working.textContent = String(s.workingCount);
      const total = s.readyCount + s.workingCount;
      const saveBtn = qs<HTMLButtonElement>("#wf-save");
      if (saveBtn) {
        saveBtn.disabled = total > 0;
        saveBtn.title = total > 0 ? "stop orchestrator and drain the queue first" : "";
      }
    })
    .catch(() => {
      // leave counts as-is on transient failure
    });
}

async function load(): Promise<void> {
  const loader = qs<HTMLElement>("#workflow-loader");
  const body = qs<HTMLElement>("#workflow-body");
  if (loader === null || body === null) {
    return;
  }
  try {
    const [wf, skills] = await Promise.all([api.getWorkflow(), api.getSkills()]);
    phases = wf.phases;
    skillsList = skills;
    const skillsRow = qs("#workflow-skills");
    if (skillsRow) {
      skillsRow.innerHTML =
        "skills available: " +
        skillsList.map((s) => `${escapeHtml(s.name)}${s.disabled ? " (disabled)" : ""}`).join(", ");
    }
    renderPhases();
    refreshQueueCount();
    loader.style.display = "none";
    body.style.display = "block";
  } catch (err) {
    loader.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function showResult(data: WorkflowValidateResponse): void {
  const msg = qs("#wf-message");
  if (msg === null) {
    return;
  }
  const errs = data.errors.map((e) => `<li class="err">${escapeHtml(e)}</li>`).join("");
  const warns = data.warnings.map((w) => `<li class="warn">${escapeHtml(w)}</li>`).join("");
  if (data.ok) {
    msg.innerHTML = '<span class="ok">valid</span>' + (warns ? `<ul>${warns}</ul>` : "");
  } else {
    msg.innerHTML = `<span class="err">invalid</span><ul>${errs}${warns}</ul>`;
  }
}

function bindAdd(): void {
  const btn = qs("#wf-add");
  if (btn === null) {
    return;
  }
  btn.addEventListener("click", () => {
    const defaultSkill = skillsList[0]?.name ?? "coder";
    phases.push({
      name: "new-phase",
      label: "New Phase",
      type: "automated",
      skill: defaultSkill,
      next: "done",
      assignTo: "ai",
    });
    renderPhases();
  });
}

function bindValidate(): void {
  const btn = qs("#wf-validate");
  if (btn === null) {
    return;
  }
  btn.addEventListener("click", () => {
    const msg = qs("#wf-message");
    if (msg) {
      msg.innerHTML = "validating…";
    }
    api
      .validateWorkflow(phases)
      .then(({ data }) => {
        showResult(data);
      })
      .catch((err: unknown) => {
        if (msg) {
          msg.innerHTML = `<span class="err">validate failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`;
        }
      });
  });
}

function handleSaveResult(res: { status: number; ok: boolean; data: WorkflowPutResponse }): void {
  const msg = qs("#wf-message");
  if (msg === null) {
    return;
  }
  const { status, ok, data } = res;
  if (status === 409 && "message" in data) {
    msg.innerHTML =
      `<span class="err">${escapeHtml(data.message)}</span> ` +
      '<button type="button" id="wf-stop-service">Stop service</button>';
    const btn = qs("#wf-stop-service");
    if (btn) {
      btn.addEventListener("click", () => {
        api
          .serviceStop()
          .then(() => {
            const m = qs("#wf-message");
            if (m) {
              m.innerHTML = '<span class="ok">stop dispatched</span>';
            }
          })
          .catch((err: unknown) => {
            const m = qs("#wf-message");
            if (m) {
              m.innerHTML = `<span class="err">stop failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`;
            }
          });
      });
    }
    return;
  }
  if (ok && "ok" in data && data.ok === true) {
    const applied =
      data.applied.length > 0 ? ` — applied: ${data.applied.map(escapeHtml).join(", ")}` : "";
    const restart =
      data.restartRequired.length > 0
        ? `<br><span class="warn">restart required: ${data.restartRequired.map(escapeHtml).join(", ")}</span>`
        : "";
    msg.innerHTML = `<span class="ok">saved</span>${applied}${restart}`;
    void load();
    return;
  }
  if ("ok" in data && data.ok === false) {
    showResult(data);
  }
}

function bindSave(): void {
  const btn = qs("#wf-save");
  if (btn === null) {
    return;
  }
  btn.addEventListener("click", () => {
    const msg = qs("#wf-message");
    if (msg) {
      msg.innerHTML = "saving…";
    }
    api
      .putWorkflow(phases)
      .then(handleSaveResult)
      .catch((err: unknown) => {
        const m = qs("#wf-message");
        if (m) {
          m.innerHTML = `<span class="err">save failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`;
        }
      });
  });
}

export function init(): void {
  if (qs("#workflow-panel") === null) {
    return;
  }
  bindAdd();
  bindValidate();
  bindSave();
  void load();
}
