import { describe, expect, it } from "vitest";
import { renderShell } from "../html/shell.js";
import { renderStatusPartial } from "../html/partials/status.js";
import { renderServicePartial } from "../html/partials/service.js";
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

  it("places the provided content inside #main", () => {
    const html = renderShell({ active: "status", content: "<p id=needle></p>" });
    expect(html).toMatch(/<main id="main">[\s\S]*<p id=needle><\/p>[\s\S]*<\/main>/);
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
});
