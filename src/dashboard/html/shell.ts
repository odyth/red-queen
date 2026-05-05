export type NavKey = "status" | "service" | "config" | "skills" | "workflow";

export interface NavTab {
  key: NavKey;
  label: string;
  partialPath: string;
}

export const NAV_TABS: readonly NavTab[] = [
  { key: "status", label: "Status", partialPath: "/api/status-partial" },
  { key: "service", label: "Service", partialPath: "/api/service-partial" },
  { key: "config", label: "Config", partialPath: "/api/config-partial" },
  { key: "skills", label: "Skills", partialPath: "/api/skills-partial" },
  { key: "workflow", label: "Workflow", partialPath: "/api/workflow-partial" },
];

export interface ShellOptions {
  active: NavKey;
  content: string;
}

const STYLES = `
  :root {
    color-scheme: dark;
    --bg: #0f1115;
    --panel: #171a21;
    --border: #2a2f3a;
    --text: #e6e8eb;
    --muted: #7d8595;
    --accent: #d14343;
    --ok: #4ade80;
    --warn: #facc15;
    --err: #f87171;
  }
  body {
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    line-height: 1.4;
  }
  header {
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 12px;
  }
  header h1 {
    margin: 0;
    font-size: 14px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }
  header .logo {
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    display: block;
  }
  header .tagline {
    color: var(--muted);
    font-size: 12px;
    letter-spacing: 0.02em;
  }
  header .status {
    margin-left: auto;
    color: var(--muted);
  }
  nav.tabs {
    display: flex;
    gap: 4px;
    padding: 0 20px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  nav.tabs button {
    background: transparent;
    border: 0;
    color: var(--muted);
    padding: 10px 14px;
    font-family: inherit;
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  nav.tabs button:hover {
    color: var(--text);
  }
  nav.tabs button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  main {
    display: grid;
    grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);
    gap: 12px;
    padding: 12px 20px 40px;
  }
  main.single {
    grid-template-columns: 1fr;
  }
  section {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 12px 14px;
  }
  section h2 {
    margin: 0 0 10px;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .kv {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 4px 10px;
  }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 4px 0; border-bottom: 1px dashed var(--border); }
  li:last-child { border-bottom: 0; }
  .pill {
    display: inline-block;
    padding: 0 6px;
    border-radius: 3px;
    background: #222832;
    font-size: 11px;
    margin-right: 6px;
  }
  .p0 { color: var(--err); }
  .p1 { color: var(--warn); }
  .pN { color: var(--muted); }
  .ok { color: var(--ok); }
  .warn { color: var(--warn); }
  .err { color: var(--err); }
  .muted { color: var(--muted); }
  .span2 { grid-column: span 2; }
  .empty { color: var(--muted); font-style: italic; }
  .log { font-size: 12px; max-height: 360px; overflow-y: auto; }
  .log li { white-space: pre-wrap; word-break: break-word; }
  .btn-row {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .btn-row button {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 12px;
    font-family: inherit;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
    border-radius: 3px;
  }
  .btn-row button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .btn-row button[disabled] {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .status-pill {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .status-pill.running { background: rgba(74, 222, 128, 0.15); color: var(--ok); }
  .status-pill.stopped { background: rgba(125, 133, 149, 0.2); color: var(--muted); }
  .status-pill.unknown { background: rgba(250, 204, 21, 0.15); color: var(--warn); }
  .status-pill.missing { background: rgba(248, 113, 113, 0.15); color: var(--err); }
`;

function renderNav(active: NavKey): string {
  return NAV_TABS.map((tab) => {
    const cls = tab.key === active ? "active" : "";
    return `<button class="${cls}" hx-get="${tab.partialPath}" hx-target="#main" hx-swap="innerHTML">${escapeHtml(tab.label)}</button>`;
  }).join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderShell(options: ShellOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Red Queen — Pipeline</title>
<!-- Defense in depth: disable htmx's eval / inline-script execution. The
     dashboard only renders its own backend HTML, so hx-vars expressions
     and server-provided <script> tags are never intentional. -->
<meta name="htmx-config" content='{"allowEval":false,"allowScriptTags":false,"includeIndicatorStyles":true}' />
<style>${STYLES}</style>
<script src="/assets/htmx.min.js" defer></script>
</head>
<body>
<header>
  <img class="logo" src="/assets/brand/logo.png" alt="Red Queen" />
  <h1>Red Queen</h1>
  <span class="tagline">Named for the AI that ran The Hive. Yours runs your SDLC.</span>
  <span id="status-line" class="muted">connecting...</span>
  <span class="status" id="uptime"></span>
</header>
<nav class="tabs">${renderNav(options.active)}</nav>
<main id="main">${options.content}</main>
</body>
</html>
`;
}
