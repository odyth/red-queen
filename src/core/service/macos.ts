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
    await bootstrapAndVerify(context);
    await runLaunchctl(["kickstart", serviceTarget(context.name)]);
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
    // After `redqueen service stop` (bootout), the job is fully unloaded —
    // re-bootstrap from the existing plist. launchctl bootstrap exits 0
    // even when it silently no-ops (the plist never registers), so
    // bootstrapAndVerify re-checks `isLoaded` and throws loudly if the
    // domain still doesn't see the job. kickstart then forces the start
    // regardless of whether RunAtLoad fired.
    if ((await isLoaded(context.name)) === false) {
      await bootstrapAndVerify(context);
    }
    await runLaunchctl(["kickstart", serviceTarget(context.name)]);
    await this.waitUntilRunning(context);
  }

  async stop(context: ServiceInstallContext): Promise<void> {
    await safeBootout(context.name);
  }

  async restart(context: ServiceInstallContext): Promise<void> {
    if ((await isLoaded(context.name)) === false) {
      await bootstrapAndVerify(context);
      // Freshly bootstrapped — no running instance to stop, so kickstart
      // without -k. Using -k here would race with RunAtLoad.
      await runLaunchctl(["kickstart", serviceTarget(context.name)]);
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

/**
 * `launchctl bootstrap` exits 0 even when it silently fails to register the
 * plist (seen in practice after bootout on some macOS releases). Verify by
 * probing `launchctl print` — if the domain still doesn't see the job, throw
 * with enough context to point the user at the root cause instead of letting
 * waitUntilRunning time out silently.
 */
async function bootstrapAndVerify(context: ServiceInstallContext): Promise<void> {
  const plistPath = plistPathFor(context.name);
  try {
    await runLaunchctl(["bootstrap", domainTarget(), plistPath]);
  } catch (err) {
    throw new Error(
      `launchctl bootstrap failed for '${context.name}': ${describeLaunchctlError(err)}`,
      { cause: err },
    );
  }
  if ((await isLoaded(context.name)) === false) {
    throw new Error(
      `launchctl bootstrap exited 0 but '${context.name}' is not registered in ${domainTarget()}. The plist at ${plistPath} may be malformed or missing; check ${context.stderrLogPath} and macOS Console for launchd errors, or run \`redqueen service install\`.`,
    );
  }
}

function describeLaunchctlError(err: unknown): string {
  if (err === null || typeof err !== "object") {
    return String(err);
  }
  const stderr = (err as { stderr?: unknown }).stderr;
  const stderrText =
    typeof stderr === "string" ? stderr : stderr instanceof Buffer ? stderr.toString("utf8") : "";
  const message = (err as { message?: unknown }).message;
  const messageText = typeof message === "string" ? message : "";
  const combined = [messageText, stderrText].filter((s) => s.length > 0).join(" — ");
  return combined.length > 0 ? combined : "unknown launchctl error";
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
