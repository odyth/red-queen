import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DualWriteAuditLogger } from "../../core/audit.js";
import { SCHEMA_SQL } from "../../core/database.js";
import { OrchestratorStateStore } from "../../core/pipeline-state.js";
import { SqliteTaskQueue } from "../../core/queue.js";
import type {
  ServiceInstallContext,
  ServiceManager,
  ServiceStatus,
} from "../../core/service/index.js";
import { DashboardServer } from "../server.js";

function makeContext(): ServiceInstallContext {
  return {
    name: "sh.redqueen.test1234",
    workingDirectory: "/tmp/project",
    envFilePath: "/tmp/project/.env",
    stdoutLogPath: "/tmp/project/.redqueen/out.log",
    stderrLogPath: "/tmp/project/.redqueen/err.log",
    wrapperScriptPath: "/tmp/project/.redqueen/run-redqueen.sh",
    redqueenBinPath: "/usr/local/bin/redqueen",
    restart: "on-failure",
  };
}

function makeStatus(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    installed: false,
    running: false,
    name: "sh.redqueen.test1234",
    pid: null,
    platform: "darwin",
    stdoutLog: "/tmp/project/.redqueen/out.log",
    stderrLog: "/tmp/project/.redqueen/err.log",
    ...overrides,
  };
}

class FakeServiceManager implements ServiceManager {
  readonly platform = "darwin" as const;
  statusValue: ServiceStatus = makeStatus();
  installed = false;
  install = vi.fn(async () => Promise.resolve());
  uninstall = vi.fn(async () => Promise.resolve());
  start = vi.fn(async () => Promise.resolve());
  stop = vi.fn(async () => Promise.resolve());
  restart = vi.fn(async () => Promise.resolve());
  status = vi.fn(async () => Promise.resolve(this.statusValue));
}

async function getFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolvePort) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr !== null ? addr.port : 0;
      s.close(() => {
        resolvePort(p);
      });
    });
  });
}

let db: BetterSqlite3.Database;
let tempDir: string;
let server: DashboardServer;
let fake: FakeServiceManager;
let port: number;
let ctx: ServiceInstallContext;

async function boot(withService: boolean): Promise<void> {
  tempDir = mkdtempSync(join(tmpdir(), "rq-svc-api-"));
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  const queue = new SqliteTaskQueue(db);
  const orchestratorState = new OrchestratorStateStore(db);
  const audit = new DualWriteAuditLogger(db, join(tempDir, "audit.log"));
  port = await getFreePort();
  fake = new FakeServiceManager();
  ctx = makeContext();
  server = new DashboardServer(
    {
      queue,
      orchestratorState,
      audit,
      service: withService ? { manager: fake, context: ctx } : undefined,
    },
    { host: "127.0.0.1", port, enableDashboardUi: true },
  );
  await server.start();
}

async function shutdown(): Promise<void> {
  await server.stop();
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
}

describe("DashboardServer — service API", () => {
  afterEach(async () => {
    await shutdown();
  });

  it("GET /api/service reports installed: false when service manager says so", async () => {
    await boot(true);
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/service`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ServiceStatus;
    expect(body.installed).toBe(false);
    expect(fake.status).toHaveBeenCalledTimes(1);
  });

  it("GET /api/service returns installed: true and pid when running", async () => {
    await boot(true);
    fake.statusValue = makeStatus({ installed: true, running: true, pid: 4242 });
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/service`);
    const body = (await res.json()) as ServiceStatus;
    expect(body.installed).toBe(true);
    expect(body.running).toBe(true);
    expect(body.pid).toBe(4242);
  });

  it("POST /api/service/start invokes the manager exactly once and returns the partial", async () => {
    await boot(true);
    fake.statusValue = makeStatus({ installed: true, running: true, pid: 99 });
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/service/start`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(text).toContain(`status-pill running`);
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(fake.start).toHaveBeenCalledWith(ctx);
  });

  it("POST /api/service/stop and /api/service/restart dispatch correctly", async () => {
    await boot(true);
    fake.statusValue = makeStatus({ installed: true, running: false });
    await fetch(`http://127.0.0.1:${String(port)}/api/service/stop`, { method: "POST" });
    expect(fake.stop).toHaveBeenCalledTimes(1);
    await fetch(`http://127.0.0.1:${String(port)}/api/service/restart`, { method: "POST" });
    expect(fake.restart).toHaveBeenCalledTimes(1);
  });

  it("GET /assets/htmx.min.js serves the vendored script with application/javascript", async () => {
    await boot(true);
    const res = await fetch(`http://127.0.0.1:${String(port)}/assets/htmx.min.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    expect(res.headers.get("cache-control")).toContain("max-age=31536000");
    const text = await res.text();
    expect(text).toContain("htmx.org 1.9.12");
  });

  it("GET /api/service-partial returns renderable HTML even without service deps", async () => {
    await boot(false);
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/service-partial`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("service-panel");
    expect(text).toContain("redqueen service install");
  });

  it("without service deps, /api/service/start responds 404", async () => {
    await boot(false);
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/service/start`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

beforeEach(() => {
  // ensure clean state per-test
});
