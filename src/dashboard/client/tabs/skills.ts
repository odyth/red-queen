import { api } from "../api.js";
import { escapeHtml, qs, qsa } from "../dom.js";
import type { SkillEntry, SkillMutateFail, SkillMutateOk } from "../../shared/api-types.js";

let currentSkill: string | null = null;

function isSuccess(data: SkillMutateOk | SkillMutateFail): data is SkillMutateOk {
  return "ok" in data;
}

function failMessage(data: SkillMutateOk | SkillMutateFail, fallback: string): string {
  if (isSuccess(data)) {
    return fallback;
  }
  return data.message ?? data.error ?? fallback;
}

function renderRows(rows: SkillEntry[]): void {
  const tbody = qs<HTMLElement>("#skills-rows");
  if (tbody === null) {
    return;
  }
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">(no skills)</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      const refs = r.referencedBy.map(escapeHtml).join(", ");
      const disabled = r.disabled
        ? '<span class="err">yes</span>'
        : '<span class="muted">no</span>';
      return (
        `<tr data-name="${escapeHtml(r.name)}" style="cursor:pointer;border-top:1px solid var(--border)">` +
        `<td style="padding:6px 8px"><strong>${escapeHtml(r.name)}</strong></td>` +
        `<td style="padding:6px 8px"><span class="pill pN">${escapeHtml(r.origin)}</span></td>` +
        `<td style="padding:6px 8px">${disabled}</td>` +
        `<td style="padding:6px 8px" class="muted">${refs.length > 0 ? refs : "—"}</td>` +
        "</tr>"
      );
    })
    .join("");
  qsa<HTMLElement>("tr[data-name]", tbody).forEach((row) => {
    row.addEventListener("click", () => {
      const name = row.getAttribute("data-name");
      if (name !== null) {
        openEditor(name);
      }
    });
  });
}

async function load(): Promise<void> {
  const loader = qs<HTMLElement>("#skills-loader");
  const body = qs<HTMLElement>("#skills-body");
  if (loader === null || body === null) {
    return;
  }
  try {
    const rows = await api.getSkills();
    renderRows(rows);
    loader.style.display = "none";
    body.style.display = "block";
  } catch (err) {
    loader.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function openEditor(name: string): void {
  currentSkill = name;
  const editor = qs<HTMLElement>("#skill-editor");
  const nameEl = qs("#skill-editor-name");
  const msg = qs("#skill-message");
  if (editor) {
    editor.style.display = "block";
  }
  if (nameEl) {
    nameEl.textContent = name;
  }
  if (msg) {
    msg.innerHTML = "";
  }
  api
    .getSkill(name)
    .then((data) => {
      const content = qs<HTMLTextAreaElement>("#skill-content");
      if (content) {
        content.value = data.content;
      }
    })
    .catch((err: unknown) => {
      if (msg) {
        msg.innerHTML = `<span class="err">load failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`;
      }
    });
}

function bindSave(): void {
  const btn = qs("#skill-save");
  if (btn === null) {
    return;
  }
  btn.addEventListener("click", () => {
    if (currentSkill === null) {
      return;
    }
    const content = qs<HTMLTextAreaElement>("#skill-content")?.value ?? "";
    api
      .putSkill(currentSkill, content)
      .then(({ ok, data }) => {
        const msg = qs("#skill-message");
        if (msg === null) {
          return;
        }
        if (ok && isSuccess(data)) {
          msg.innerHTML = '<span class="ok">saved</span>';
          void load();
        } else {
          msg.innerHTML = `<span class="err">${escapeHtml(failMessage(data, "save failed"))}</span>`;
        }
      })
      .catch((err: unknown) => {
        const msg = qs("#skill-message");
        if (msg) {
          msg.innerHTML = `<span class="err">save failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`;
        }
      });
  });
}

function bindDelete(): void {
  const btn = qs("#skill-delete");
  if (btn === null) {
    return;
  }
  btn.addEventListener("click", () => {
    if (currentSkill === null) {
      return;
    }
    api
      .deleteSkill(currentSkill)
      .then(({ ok, data }) => {
        const msg = qs("#skill-message");
        if (msg === null) {
          return;
        }
        if (ok && isSuccess(data)) {
          msg.innerHTML = '<span class="ok">user override removed</span>';
          void load();
        } else {
          msg.innerHTML = `<span class="err">${escapeHtml(failMessage(data, "delete failed"))}</span>`;
        }
      })
      .catch((err: unknown) => {
        const msg = qs("#skill-message");
        if (msg) {
          msg.innerHTML = `<span class="err">delete failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`;
        }
      });
  });
}

function bindCancel(): void {
  const btn = qs("#skill-cancel");
  if (btn === null) {
    return;
  }
  btn.addEventListener("click", () => {
    const editor = qs<HTMLElement>("#skill-editor");
    if (editor) {
      editor.style.display = "none";
    }
    currentSkill = null;
  });
}

function bindCreate(): void {
  const btn = qs("#new-skill-create");
  if (btn === null) {
    return;
  }
  btn.addEventListener("click", () => {
    const input = qs<HTMLInputElement>("#new-skill-name");
    const msg = qs("#new-skill-message");
    if (input === null) {
      return;
    }
    const name = input.value.trim();
    if (name.length === 0) {
      if (msg) {
        msg.innerHTML = '<span class="err">name required</span>';
      }
      return;
    }
    api
      .putSkill(name, `# ${name}\n\n`)
      .then(({ ok, data }) => {
        if (msg === null) {
          return;
        }
        if (ok && isSuccess(data)) {
          msg.innerHTML = '<span class="ok">created</span>';
          input.value = "";
          void load();
          openEditor(name);
        } else {
          msg.innerHTML = `<span class="err">${escapeHtml(failMessage(data, "create failed"))}</span>`;
        }
      })
      .catch((err: unknown) => {
        if (msg) {
          msg.innerHTML = `<span class="err">create failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`;
        }
      });
  });
}

export function init(): void {
  if (qs("#skills-panel") === null) {
    return;
  }
  bindSave();
  bindDelete();
  bindCancel();
  bindCreate();
  void load();
}
