import { renderStatusPartial } from "./html/partials/status.js";
import { renderShell } from "./html/shell.js";

export function renderDashboardHtml(): string {
  return renderShell({ active: "status", content: renderStatusPartial() });
}

export { renderShell, NAV_TABS } from "./html/shell.js";
export type { NavKey, NavTab } from "./html/shell.js";
export { renderStatusPartial } from "./html/partials/status.js";
export { renderServicePartial } from "./html/partials/service.js";
