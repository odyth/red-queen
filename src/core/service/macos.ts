import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  ServiceManager,
  extractStdout,
  type ServiceInstallContext,
  type ServiceStatus,
} from "./manager.js";

const execFileAsync = promisify(execFile);

const LAUNCHCTL = "/bin/launchctl";

export function launchAgentsDir(): string {
  return resolve(homedir(), "Library", "LaunchAgents");
}

export function plistPathFor(name: string): string {
  return resolve(launchAgentsDir(), `${name}.plist`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function keepAliveSnippet(restart: ServiceInstallContext["restart"]): string {
  if (restart === "always") {
    return ["  <key>KeepAlive</key>", "  <true/>"].join("\n");
  }
  if (restart === "on-failure") {
    return [
      "  <key>KeepAlive</key>",
      "  <dict>",
      "    <key>SuccessfulExit</key>",
      "    <false/>",
      "  </dict>",
    ].join("\n");
  }
  return "";
}

export function renderPlist(context: ServiceInstallContext): string {
  const keepAlive = keepAliveSnippet(context.restart);
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${escapeXml(context.name)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${escapeXml(context.wrapperScriptPath)}</string>`,
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXml(context.workingDirectory)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXml(context.stdoutLogPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXml(context.stderrLogPath)}</string>`,
    `  <key>ProcessType</key>`,
    `  <string>Background</string>`,
  ];
  if (keepAlive.length > 0) {
    lines.push(keepAlive);
  }
  lines.push(`</dict>`, `</plist>`, ``);
  return lines.join("\n");
}

function domainTarget(): string {
  return `gui/${String(userInfo().uid)}`;
}

function serviceTarget(name: string): string {
  return `${domainTarget()}/${name}`;
}

async function runLaunchctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(LAUNCHCTL, args);
}

export class MacServiceManager extends ServiceManager {
  readonly platform = "darwin" as const;

  async install(context: ServiceInstallContext): Promise<void> {
    const plistPath = plistPathFor(context.name);
    mkdirSync(launchAgentsDir(), { recursive: true });
    mkdirSync(dirname(context.stdoutLogPath), { recursive: true });
    mkdirSync(dirname(context.stderrLogPath), { recursive: true });
    writeFileSync(plistPath, renderPlist(context), "utf8");

    // bootout first if a prior plist is loaded — bootstrap fails otherwise.
    await safeBootout(context.name);
    await runLaunchctl(["bootstrap", domainTarget(), plistPath]);
    // launchctl exits 0 on bootstrap even when the plist failed to load.
    // Poll status as the source of truth.
    await this.waitUntilRunning(context);
  }

  async uninstall(context: ServiceInstallContext): Promise<void> {
    await safeBootout(context.name);
    const plistPath = plistPathFor(context.name);
    if (existsSync(plistPath)) {
      rmSync(plistPath, { force: true });
    }
  }

  async start(context: ServiceInstallContext): Promise<void> {
    // `launchctl kickstart` only works against a loaded job. After
    // `redqueen service stop` runs `bootout`, the job is fully unloaded —
    // bootstrap re-registers it, and with RunAtLoad=true in the plist the
    // job starts as part of bootstrap. A follow-up kickstart would race
    // against that and can leave the job in a confused state, so only
    // kickstart when the job was already loaded (no-op start case).
    if ((await isLoaded(context.name)) === false) {
      const plistPath = plistPathFor(context.name);
      await runLaunchctl(["bootstrap", domainTarget(), plistPath]);
    } else {
      await runLaunchctl(["kickstart", serviceTarget(context.name)]);
    }
    await this.waitUntilRunning(context);
  }

  async stop(context: ServiceInstallContext): Promise<void> {
    await safeBootout(context.name);
  }

  async restart(context: ServiceInstallContext): Promise<void> {
    if ((await isLoaded(context.name)) === false) {
      const plistPath = plistPathFor(context.name);
      await runLaunchctl(["bootstrap", domainTarget(), plistPath]);
    } else {
      await runLaunchctl(["kickstart", "-k", serviceTarget(context.name)]);
    }
    await this.waitUntilRunning(context);
  }

  private async waitUntilRunning(context: ServiceInstallContext): Promise<void> {
    const deadline = Date.now() + 5000;
    let lastStatus: ServiceStatus | null = null;
    while (Date.now() < deadline) {
      lastStatus = await this.status(context);
      if (lastStatus.running) {
        return;
      }
      await sleep(200);
    }
    const hint = lastStatus?.installed === false ? " (plist missing)" : "";
    throw new Error(
      `LaunchAgent '${context.name}' did not reach running state within 5s${hint}. Check ${context.stderrLogPath} for startup errors.`,
    );
  }

  async status(context: ServiceInstallContext): Promise<ServiceStatus> {
    const plistPath = plistPathFor(context.name);
    const installed = existsSync(plistPath);
    if (installed === false) {
      return {
        installed: false,
        running: false,
        name: context.name,
        pid: null,
        platform: "darwin",
        stdoutLog: context.stdoutLogPath,
        stderrLog: context.stderrLogPath,
      };
    }
    let stdout: string;
    try {
      const result = await runLaunchctl(["print", serviceTarget(context.name)]);
      stdout = result.stdout;
    } catch (err) {
      // `launchctl print` exits non-zero when the service isn't loaded in the
      // domain. The plist exists on disk but isn't active — treat as stopped.
      stdout = extractStdout(err);
    }
    const pidMatch = /\bpid\s*=\s*(\d+)/.exec(stdout);
    const stateMatch = /\bstate\s*=\s*(\S+)/.exec(stdout);
    const pid = pidMatch !== null ? Number.parseInt(pidMatch[1] ?? "", 10) : null;
    const running = stateMatch !== null && stateMatch[1] === "running";
    return {
      installed: true,
      running,
      name: context.name,
      pid: Number.isFinite(pid) ? pid : null,
      platform: "darwin",
      stdoutLog: context.stdoutLogPath,
      stderrLog: context.stderrLogPath,
    };
  }
}

async function safeBootout(name: string): Promise<void> {
  try {
    await runLaunchctl(["bootout", serviceTarget(name)]);
  } catch {
    // Already unloaded — bootout returns non-zero in that case.
  }
}

async function isLoaded(name: string): Promise<boolean> {
  try {
    await runLaunchctl(["print", serviceTarget(name)]);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readInstalledPlist(name: string): string | null {
  const path = plistPathFor(name);
  if (existsSync(path) === false) {
    return null;
  }
  return readFileSync(path, "utf8");
}
