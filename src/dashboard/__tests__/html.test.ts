import { describe, expect, it } from "vitest";
import { renderShell } from "../html/shell.js";
import { renderConfigPartial } from "../html/partials/config.js";
import { renderSkillsPartial } from "../html/partials/skills.js";
import { renderStatusPartial } from "../html/partials/status.js";
import { renderServicePartial } from "../html/partials/service.js";
import { renderWorkflowPartial } from "../html/partials/workflow.js";
import type { ServiceStatus } from "../../core/service/index.js";

describe("renderShell", () => {
  it("includes the vendored htmx script tag", () => {
    const html = renderShell({ active: "status", content: "<p>hi</p>" });
    expect(html).toContain(`src="/assets/htmx.min.js"`);
  });

  it("renders nav tabs for status and service with hx-get", () => {
    const html = renderShell({ active: "status", content: "" });
    expect(html).toContain(`hx-get="/api/status-partial"`);
    expect(html).toContain(`hx-get="/api/service-partial"`);
    expect(html).toContain(`hx-target="#main"`);
  });

  it("marks the active tab with .active", () => {
    const statusActive = renderShell({ active: "status", content: "" });
    expect(statusActive).toMatch(/<button class="active"[^>]*>Status</);
    const serviceActive = renderShell({ active: "service", content: "" });
    expect(serviceActive).toMatch(/<button class="active"[^>]*>Service</);
  });

  it("embeds the controller script and data-tab hooks for client-side switching", () => {
    const html = renderShell({ active: "status", content: "" });
    // Controller lives in the shell so htmx's allowScriptTags:false does
    // not drop it when partials get swapped in.
    expect(html).toContain("__rqShellInit");
    expect(html).toContain('data-tab="status"');
    expect(html).toContain('data-tab="service"');
    expect(html).toContain('data-tab="config"');
    expect(html).toContain('data-tab="skills"');
    expect(html).toContain('data-tab="workflow"');
    // Header uptime is driven by the shell controller (d h m s format).
    expect(html).toContain("fmtDuration");
  });

  it("places the provided content inside #main", () => {
    const html = renderShell({ active: "status", content: "<p id=needle></p>" });
    expect(html).toMatch(/<main id="main">[\s\S]*<p id=needle><\/p>[\s\S]*<\/main>/);
  });

  // tsc cannot see inside the CONTROLLER_JS template literal, so a
  // malformed escape sequence in that string only surfaces as a browser
  // SyntaxError at runtime — which killed every tab init in the first
  // cut of this commit. Parsing the emitted script here catches that
  // class of bug at test time.
  it("emits a controller script that parses as valid JavaScript", () => {
    const html = renderShell({ active: "status", content: "" });
    const scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))
      .map((m) => m[1])
      .filter((body) => body.trim().length > 0);
    expect(scripts.length).toBeGreaterThan(0);
    const controller = scripts[scripts.length - 1];
    expect(controller).toContain("__rqShellInit");
    // new Function() here only compiles the source — the body is never
    // invoked — so this is a parse check, not an eval.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(controller)).not.toThrow();
  });
});

describe("renderStatusPartial", () => {
  it("contains the worker/stats/queue/log skeletons", () => {
    const html = renderStatusPartial();
    expect(html).toContain(`id="worker"`);
    expect(html).toContain(`id="queue"`);
    expect(html).toContain(`id="log"`);
  });
});

describe("partials are script-free", () => {
  // htmx swaps these into #main with allowScriptTags:false, which silently
  // drops inline <script> tags. Partial logic must live in the shell —
  // asserting no <script> tag here prevents a regression where a partial
  // ships its own inline handler and then never runs on tab switch.
  it.each([
    ["status", renderStatusPartial()],
    ["config", renderConfigPartial()],
    ["skills", renderSkillsPartial()],
    ["workflow", renderWorkflowPartial()],
  ])("%s partial has no <script> tags", (_name, html) => {
    expect(html).not.toMatch(/<script\b/i);
  });
});

describe("renderServicePartial", () => {
  const base: ServiceStatus = {
    installed: true,
    running: true,
    name: "sh.redqueen.abcdef12",
    pid: 1234,
    platform: "darwin",
    stdoutLog: "/tmp/out.log",
    stderrLog: "/tmp/err.log",
  };

  it("renders the running pill and control buttons when installed + running", () => {
    const html = renderServicePartial(base);
    expect(html).toContain(`status-pill running`);
    expect(html).toContain(`hx-post="/api/service/start"`);
    expect(html).toContain(`hx-post="/api/service/stop"`);
    expect(html).toContain(`hx-post="/api/service/restart"`);
    expect(html).toContain(`hx-target="#service-panel"`);
  });

  it("renders the stopped pill when installed but not running", () => {
    const html = renderServicePartial({ ...base, running: false });
    expect(html).toContain(`status-pill stopped`);
  });

  it("hides controls and shows install instruction when not installed", () => {
    const html = renderServicePartial({ ...base, installed: false, running: false, pid: null });
    expect(html).toContain(`status-pill missing`);
    expect(html).toContain(`redqueen service install`);
    expect(html).not.toContain(`hx-post=`);
  });

  it("renders a friendly unsupported-platform message without controls", () => {
    const html = renderServicePartial({
      ...base,
      installed: false,
      running: false,
      pid: null,
      platform: "unsupported",
    });
    expect(html).toContain("only supported on macOS");
    expect(html).not.toContain("hx-post=");
  });
});

describe("renderShell (htmx defense)", () => {
  it("disables htmx eval via the htmx-config meta tag", () => {
    const html = renderShell({ active: "status", content: "" });
    expect(html).toContain(`name="htmx-config"`);
    expect(html).toContain(`"allowEval":false`);
    expect(html).toContain(`"allowScriptTags":false`);
  });
});
