import { qs, qsa } from "./dom.js";
import { startUptimeTicker } from "./uptime.js";
import * as statusTab from "./tabs/status.js";
import * as configTab from "./tabs/config.js";
import * as skillsTab from "./tabs/skills.js";
import * as workflowTab from "./tabs/workflow.js";
import { connect as connectSse } from "./sse.js";

interface ShellWindow extends Window {
  __rqShellInit?: boolean;
}

const w = window as ShellWindow;
if (w.__rqShellInit !== true) {
  w.__rqShellInit = true;
  main();
}

type InitFn = () => void;

const INIT: Record<string, InitFn> = {
  status: statusTab.init,
  config: configTab.init,
  skills: skillsTab.init,
  workflow: workflowTab.init,
};

function activeTabKey(): string | null {
  const btn = qs("nav.tabs button.active");
  return btn === null ? null : btn.getAttribute("data-tab");
}

function main(): void {
  startUptimeTicker();

  // Keep the nav underline in sync with the currently visible tab — htmx
  // does the swap, we just update .active.
  document.body.addEventListener("click", (evt) => {
    const target = evt.target;
    if (target === null || !(target instanceof Element)) {
      return;
    }
    const btn = target.closest<HTMLElement>("nav.tabs button[data-tab]");
    if (btn === null) {
      return;
    }
    qsa<HTMLElement>("nav.tabs button[data-tab]").forEach((b) => {
      b.classList.remove("active");
    });
    btn.classList.add("active");
  });

  // After each htmx swap into #main, re-run the init for whichever tab
  // landed. Initial-load init is handled below (htmx doesn't fire
  // afterSettle for server-rendered content).
  document.body.addEventListener("htmx:afterSettle", (evt) => {
    const target = (evt as Event & { target: EventTarget | null }).target;
    if (!(target instanceof HTMLElement) || target.id !== "main") {
      return;
    }
    const key = activeTabKey();
    if (key !== null && key in INIT) {
      INIT[key]?.();
    }
  });

  connectSse(activeTabKey);

  // Script tag is at the bottom of <body>, so in practice readyState is
  // "interactive" or "complete" by the time we run. Guard anyway in case
  // a future change moves the tag or adds `type=module` loading.
  const runInitial = (): void => {
    const key = activeTabKey();
    if (key !== null && key in INIT) {
      INIT[key]?.();
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runInitial);
  } else {
    runInitial();
  }
}
