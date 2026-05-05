import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  ServiceManager,
  extractStdout,
  type ServiceInstallContext,
  type ServiceStatus,
} from "./manager.js";

const execFileAsync = promisify(execFile);

// Hardcode the absolute path so systemd-user services launched from
// restricted shells (cron/launchd-like envs) don't depend on $PATH.
// Fall back to the PATH-resolved binary for distros that install it
// elsewhere (e.g. NixOS).
const SYSTEMCTL = existsSync("/usr/bin/systemctl") ? "/usr/bin/systemctl" : "systemctl";

export function systemdUserDir(): string {
  return resolve(homedir(), ".config", "systemd", "user");
}

export function unitPathFor(name: string): string {
  return resolve(systemdUserDir(), `${name}.service`);
}

function restartDirective(restart: ServiceInstallContext["restart"]): string {
  if (restart === "always") {
    return "always";
  }
  if (restart === "on-failure") {
    return "on-failure";
  }
  return "no";
}

export function renderUnit(context: ServiceInstallContext): string {
  const restart = restartDirective(context.restart);
  return [
    "[Unit]",
    "Description=Red Queen orchestrator",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${context.workingDirectory}`,
    `EnvironmentFile=${context.envFilePath}`,
    `ExecStart=${context.wrapperScriptPath}`,
    `StandardOutput=append:${context.stdoutLogPath}`,
    `StandardError=append:${context.stderrLogPath}`,
    `Restart=${restart}`,
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

async function runSystemctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(SYSTEMCTL, ["--user", ...args]);
}

export class LinuxServiceManager extends ServiceManager {
  readonly platform = "linux" as const;

  async install(context: ServiceInstallContext): Promise<void> {
    const unitPath = unitPathFor(context.name);
    mkdirSync(systemdUserDir(), { recursive: true });
    mkdirSync(dirname(context.stdoutLogPath), { recursive: true });
    mkdirSync(dirname(context.stderrLogPath), { recursive: true });
    writeFileSync(unitPath, renderUnit(context), "utf8");
    await runSystemctl(["daemon-reload"]);
    await runSystemctl(["enable", context.name]);
    // Match macOS: `bootstrap` loads and starts the plist (RunAtLoad=true), so
    // `install` returns with the service running. Do the same via `start` here
    // so the printed banner's "service status" step tells the truth.
    await runSystemctl(["start", context.name]);
  }

  async uninstall(context: ServiceInstallContext): Promise<void> {
    await safeSystemctl(["stop", context.name]);
    await safeSystemctl(["disable", context.name]);
    const unitPath = unitPathFor(context.name);
    if (existsSync(unitPath)) {
      rmSync(unitPath, { force: true });
    }
    await safeSystemctl(["daemon-reload"]);
  }

  async start(context: ServiceInstallContext): Promise<void> {
    await runSystemctl(["start", context.name]);
  }

  async stop(context: ServiceInstallContext): Promise<void> {
    await runSystemctl(["stop", context.name]);
  }

  async restart(context: ServiceInstallContext): Promise<void> {
    await runSystemctl(["restart", context.name]);
  }

  async status(context: ServiceInstallContext): Promise<ServiceStatus> {
    const unitPath = unitPathFor(context.name);
    const installed = existsSync(unitPath);
    if (installed === false) {
      return {
        installed: false,
        running: false,
        name: context.name,
        pid: null,
        platform: "linux",
        stdoutLog: context.stdoutLogPath,
        stderrLog: context.stderrLogPath,
      };
    }
    let stdout: string;
    try {
      const result = await runSystemctl(["show", context.name, "--property=ActiveState,MainPID"]);
      stdout = result.stdout;
    } catch (err) {
      stdout = extractStdout(err);
    }
    const activeMatch = /ActiveState=(\S+)/.exec(stdout);
    const pidMatch = /MainPID=(\d+)/.exec(stdout);
    const running = activeMatch !== null && activeMatch[1] === "active";
    const rawPid = pidMatch !== null ? Number.parseInt(pidMatch[1] ?? "", 10) : 0;
    const pid = Number.isFinite(rawPid) && rawPid > 0 ? rawPid : null;
    return {
      installed: true,
      running,
      name: context.name,
      pid,
      platform: "linux",
      stdoutLog: context.stdoutLogPath,
      stderrLog: context.stderrLogPath,
    };
  }
}

async function safeSystemctl(args: string[]): Promise<void> {
  try {
    await runSystemctl(args);
  } catch {
    // Unit already stopped/disabled/missing.
  }
}

export function readInstalledUnit(name: string): string | null {
  const path = unitPathFor(name);
  if (existsSync(path) === false) {
    return null;
  }
  return readFileSync(path, "utf8");
}
