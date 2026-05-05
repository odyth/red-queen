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

  it("references the controller bundle and data-tab hooks for client-side switching", () => {
    const html = renderShell({ active: "status", content: "" });
    // Controller ships as a static asset (src/dashboard/client → esbuild
    // → /assets/controller.js). The shell points at it with a <script src>
    // so it bypasses htmx's allowScriptTags:false policy and so browsers
    // can cache it independently of the HTML doc.
    expect(html).toContain(`src="/assets/controller.js"`);
    expect(html).toContain('data-tab="status"');
    expect(html).toContain('data-tab="service"');
    expect(html).toContain('data-tab="config"');
    expect(html).toContain('data-tab="skills"');
    expect(html).toContain('data-tab="workflow"');
  });

  it("places the provided content inside #main", () => {
    const html = renderShell({ active: "status", content: "<p id=needle></p>" });
    expect(html).toMatch(/<main id="main">[\s\S]*<p id=needle><\/p>[\s\S]*<\/main>/);
  });

  it("ships no inline <script> bodies (everything should be src= references)", () => {
    const html = renderShell({ active: "status", content: "" });
    // Regression guard: prior to the client-bundle migration the shell
    // embedded ~600 lines of JS inline. Any inline <script>…</script> body
    // sneaking back in would lose type-checking and cache benefits.
    // Strip HTML comments first so commentary mentioning "<script>" doesn't
    // trip the regex.
    const stripped = html.replace(/<!--[\s\S]*?-->/g, "");
    const inlineBodies = Array.from(stripped.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))
      .map((m) => m[1]?.trim() ?? "")
      .filter((body) => body.length > 0);
    expect(inlineBodies).toEqual([]);
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
