import { api } from "../api.js";
import { escapeHtml, fmtPriority, qs } from "../dom.js";
import { setStartedAt } from "../uptime.js";
import type {
  AuditEntryWire,
  StatusPayload,
  TaskSummary,
  WorkerStartedPayload,
} from "../../shared/api-types.js";

export interface PartialWorkerUpdate {
  status: "working" | "idle";
  issueId?: string | null;
  type?: string;
  elapsed?: number;
}

function setWorker(task: StatusPayload["currentTask"] | PartialWorkerUpdate | null): void {
  const ws = qs("#worker-status");
  if (ws === null) {
    return;
  }
  if (task?.status !== "working") {
    ws.textContent = "idle";
    ws.className = "muted";
    const issue = qs("#worker-issue");
    const kind = qs("#worker-task");
    const elapsed = qs("#worker-elapsed");
    const hb = qs("#worker-heartbeat");
    if (issue) {
      issue.textContent = "—";
    }
    if (kind) {
      kind.textContent = "—";
    }
    if (elapsed) {
      elapsed.textContent = "—";
    }
    if (hb) {
      hb.textContent = "—";
    }
    return;
  }
  ws.textContent = "working";
  ws.className = "ok";
  const issueEl = qs("#worker-issue");
  const kindEl = qs("#worker-task");
  const elapsedEl = qs("#worker-elapsed");
  if (issueEl) {
    issueEl.textContent = task.issueId ?? "—";
  }
  if (kindEl) {
    const type = "type" in task ? task.type : undefined;
    const description = "description" in task ? task.description : null;
    kindEl.textContent = (type ?? "") + (description !== null ? ` — ${description}` : "");
  }
  if (elapsedEl) {
    const elapsed = "elapsed" in task ? task.elapsed : undefined;
    elapsedEl.textContent = elapsed !== undefined ? `${String(elapsed)}s` : "—";
  }
}

function setStats(s: StatusPayload): void {
  const el = qs("#stat-status");
  if (el === null) {
    return;
  }
  el.textContent = s.status;
  el.className = s.status === "working" ? "ok" : s.status === "crashed" ? "err" : "muted";
  const fields: [string, number | string | null][] = [
    ["#stat-completed", s.completedCount],
    ["#stat-errors", s.errorCount],
    ["#stat-ready", s.readyCount],
    ["#stat-working", s.workingCount],
    ["#stat-started", s.startedAt ?? "—"],
  ];
  for (const [sel, value] of fields) {
    const node = qs(sel);
    if (node) {
      node.textContent = String(value);
    }
  }
}

function setQueue(items: TaskSummary[] | null): void {
  const el = qs("#queue");
  if (el === null) {
    return;
  }
  if (items === null || items.length === 0) {
    el.innerHTML = '<li class="empty">(empty)</li>';
    return;
  }
  el.innerHTML = items
    .map((t) => {
      const descr =
        t.description !== null && t.description !== ""
          ? ` <span class="muted">— ${escapeHtml(t.description)}</span>`
          : "";
      return (
        "<li>" +
        fmtPriority(t.priority) +
        `<strong>${escapeHtml(t.issueId ?? "—")}</strong> · ${escapeHtml(t.type)}${descr}</li>`
      );
    })
    .join("");
}

function setLog(entries: AuditEntryWire[] | null): void {
  const el = qs("#log");
  if (el === null) {
    return;
  }
  if (entries === null || entries.length === 0) {
    el.innerHTML = '<li class="empty">(no entries)</li>';
    return;
  }
  el.innerHTML = entries
    .slice(0, 50)
    .map(
      (e) =>
        `<li><span class="muted">${escapeHtml(e.timestamp)}</span> ` +
        `<span class="pill pN">${escapeHtml(e.component)}</span>` +
        `${escapeHtml(e.issueId ?? "-")} · ${escapeHtml(e.message)}</li>`,
    )
    .join("");
}

export async function refresh(): Promise<void> {
  try {
    const [status, queue, logs] = await Promise.all([
      api.getStatus(),
      api.getQueue(),
      api.getLogs(),
    ]);
    setStartedAt(status.startedAt);
    setStats(status);
    setWorker(status.currentTask);
    setQueue(queue);
    setLog(logs);
  } catch (err) {
    const el = qs("#status-line");
    if (el) {
      el.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
      el.className = "err";
    }
  }
}

export function init(): void {
  void refresh();
}

export function applyWorkerStarted(d: WorkerStartedPayload): void {
  if (qs("#worker-status") === null) {
    return;
  }
  setWorker({ status: "working", issueId: d.issueId, type: d.taskType, elapsed: 0 });
}

export function applyWorkerHeartbeat(d: {
  elapsed: number;
  cpuPercent: string;
  rssKb: string;
  idleSeconds: number;
}): void {
  const elapsed = qs("#worker-elapsed");
  const hb = qs("#worker-heartbeat");
  if (elapsed) {
    elapsed.textContent = `${String(d.elapsed)}s`;
  }
  if (hb) {
    hb.textContent = `cpu ${d.cpuPercent}%, rss ${d.rssKb}KB, idle ${String(d.idleSeconds)}s`;
  }
}

export function clearWorker(): void {
  setWorker(null);
}
