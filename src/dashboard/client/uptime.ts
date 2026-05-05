import { fmtDuration, qs } from "./dom.js";

// Track the started-at timestamp outside the status DOM so the header
// uptime ticker survives tab switches (the status tab's DOM is replaced
// every time the user navigates away and back).
let startedAtMs: number | null = null;

export function setStartedAt(iso: string | null | undefined): void {
  if (iso === null || iso === undefined || iso === "" || iso === "—") {
    return;
  }
  const ms = new Date(iso).getTime();
  if (Number.isFinite(ms)) {
    startedAtMs = ms;
  }
}

export function startUptimeTicker(): void {
  setInterval(() => {
    const el = qs("#uptime");
    if (el === null) {
      return;
    }
    if (startedAtMs === null) {
      el.textContent = "";
      return;
    }
    const diff = Math.round((Date.now() - startedAtMs) / 1000);
    el.textContent = `uptime ${fmtDuration(diff)}`;
  }, 1000);
}
