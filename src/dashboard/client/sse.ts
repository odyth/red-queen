import { qs } from "./dom.js";
import * as status from "./tabs/status.js";
import * as workflow from "./tabs/workflow.js";
import type { DashboardEventMap, DashboardEventName } from "../shared/api-types.js";

type ActiveTabFn = () => string | null;

function addTyped<K extends DashboardEventName>(
  source: EventSource,
  name: K,
  handler: (data: DashboardEventMap[K]) => void,
): void {
  source.addEventListener(name, (evt) => {
    const e = evt as MessageEvent<string>;
    try {
      const parsed = JSON.parse(e.data) as DashboardEventMap[K];
      handler(parsed);
    } catch {
      // Malformed SSE payload — skip silently rather than crash the stream.
    }
  });
}

export function connect(getActiveTab: ActiveTabFn): void {
  let source: EventSource;
  try {
    source = new EventSource("/api/events");
  } catch {
    // EventSource constructor threw (old browser, CSP, etc). The dashboard
    // still works via tab-switch refreshes; we just don't get live updates.
    return;
  }

  source.addEventListener("open", () => {
    const el = qs("#status-line");
    if (el) {
      el.textContent = "connected";
      el.className = "ok";
    }
  });

  source.addEventListener("error", () => {
    const el = qs("#status-line");
    if (el) {
      el.textContent = "reconnecting...";
      el.className = "warn";
    }
  });

  addTyped(source, "worker:started", (d) => {
    status.applyWorkerStarted(d);
  });

  addTyped(source, "worker:heartbeat", (d) => {
    status.applyWorkerHeartbeat(d);
  });

  addTyped(source, "worker:completed", () => {
    status.clearWorker();
    if (getActiveTab() === "status") {
      void status.refresh();
    }
  });

  addTyped(source, "queue:changed", () => {
    if (getActiveTab() === "status") {
      void status.refresh();
    }
    if (getActiveTab() === "workflow") {
      workflow.refreshQueueCount();
    }
  });

  addTyped(source, "orchestrator:status", () => {
    if (getActiveTab() === "status") {
      void status.refresh();
    }
  });

  addTyped(source, "config:reloaded", () => {
    // Nothing to do here yet — the config tab reloads its own view after
    // PUTs. Wired up for parity with the server-side event map.
  });
}
