import { api } from "../api.js";
import { escapeHtml, qs } from "../dom.js";
import type { EnvRef } from "../../shared/api-types.js";

function renderEnv(refs: EnvRef[]): void {
  const el = qs("#config-env");
  if (el === null) {
    return;
  }
  if (refs.length === 0) {
    el.innerHTML = '<li class="empty">(none detected)</li>';
    return;
  }
  el.innerHTML = refs
    .map(
      (r) =>
        `<li><code>\${${escapeHtml(r.name)}}</code> — ` +
        (r.set ? '<span class="ok">set</span>' : '<span class="err">not set</span>') +
        "</li>",
    )
    .join("");
}

function setMessage(html: string, cls?: string): void {
  const el = qs("#config-message");
  if (el === null) {
    return;
  }
  el.className = cls ?? "";
  el.innerHTML = html;
}

function setRestartBanner(restartRequired: string[]): void {
  const el = qs<HTMLElement>("#config-restart");
  if (el === null) {
    return;
  }
  if (restartRequired.length === 0) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  el.style.display = "block";
  el.innerHTML =
    `Restart required for: ${restartRequired.map(escapeHtml).join(", ")}. ` +
    '<button type="button" id="config-restart-btn">Restart now</button>';
  const btn = qs("#config-restart-btn");
  if (btn) {
    btn.addEventListener("click", () => {
      api
        .serviceRestart()
        .then(() => {
          setMessage('<span class="ok">restart dispatched</span>');
        })
        .catch((err: unknown) => {
          setMessage(
            `<span class="err">restart failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`,
          );
        });
    });
  }
}

async function load(): Promise<void> {
  const loader = qs<HTMLElement>("#config-loader");
  const form = qs<HTMLElement>("#config-form");
  if (loader === null || form === null) {
    return;
  }
  try {
    const data = await api.getConfig();
    const textarea = qs<HTMLTextAreaElement>("#config-yaml");
    if (textarea) {
      textarea.value = data.yaml;
    }
    renderEnv(data.envRefs);
    loader.style.display = "none";
    form.style.display = "block";
  } catch (err) {
    loader.textContent = `error loading config: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function bindValidate(): void {
  const btn = qs("#config-validate-btn");
  if (btn === null) {
    return;
  }
  btn.addEventListener("click", () => {
    setMessage("validating…", "muted");
    const yaml = qs<HTMLTextAreaElement>("#config-yaml")?.value ?? "";
    api
      .validateConfig(yaml)
      .then(({ data }) => {
        if (data.ok) {
          const warns =
            data.warnings.length > 0
              ? `<br><span class="warn">warnings:</span><ul>${data.warnings
                  .map((w) => `<li class="warn">${escapeHtml(w)}</li>`)
                  .join("")}</ul>`
              : "";
          setMessage(`<span class="ok">valid</span>${warns}`);
        } else {
          setMessage(
            `<span class="err">invalid</span><ul>${data.errors
              .map((e) => `<li class="err">${escapeHtml(e)}</li>`)
              .join("")}</ul>`,
          );
        }
      })
      .catch((err: unknown) => {
        setMessage(
          `<span class="err">validate failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`,
        );
      });
  });
}

function bindSave(): void {
  const btn = qs("#config-save-btn");
  if (btn === null) {
    return;
  }
  btn.addEventListener("click", () => {
    setMessage("saving…", "muted");
    const yaml = qs<HTMLTextAreaElement>("#config-yaml")?.value ?? "";
    api
      .putConfig(yaml)
      .then(({ ok, data }) => {
        if (ok && data.ok) {
          const applied = data.applied;
          setMessage(
            '<span class="ok">saved</span>' +
              (applied.length > 0 ? `<br>applied: ${applied.map(escapeHtml).join(", ")}` : ""),
          );
          setRestartBanner(data.restartRequired);
          void load();
        } else if (data.ok === false) {
          setMessage(
            `<span class="err">save failed</span><ul>${data.errors
              .map((e) => `<li class="err">${escapeHtml(e)}</li>`)
              .join("")}</ul>`,
          );
        }
      })
      .catch((err: unknown) => {
        setMessage(
          `<span class="err">save failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`,
        );
      });
  });
}

function bindReload(): void {
  const btn = qs("#config-reload-btn");
  if (btn === null) {
    return;
  }
  btn.addEventListener("click", () => {
    void load();
  });
}

export function init(): void {
  if (qs("#config-panel") === null) {
    return;
  }
  bindValidate();
  bindSave();
  bindReload();
  void load();
}
