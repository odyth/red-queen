import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type RedQueenConfig } from "../core/config.js";
import {
  buildInstallContext,
  createServiceManager,
  resolveServicePaths,
  UnsupportedPlatformError,
  writeWrapperScript,
  type ServiceInstallContext,
  type ServiceManager,
  type ServiceStatus,
} from "../core/service/index.js";
import { findConfigUpward, projectRootFromConfigPath } from "./config-discovery.js";
import { CliError } from "./errors.js";

const SUBCOMMANDS = ["install", "start", "stop", "restart", "status", "uninstall"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

export async function cmdService(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    printServiceHelp();
    return;
  }
  if (isSubcommand(sub) === false) {
    throw new CliError(
      `Unknown service subcommand: ${sub}. Run 'redqueen service --help' for usage.`,
    );
  }
  if (rest.length > 0) {
    throw new CliError(`'redqueen service ${sub}' takes no arguments.`);
  }

  const configPath = findConfigUpward(process.cwd());
  if (configPath === null) {
    throw new CliError(`redqueen.yaml not found (searched from ${process.cwd()} upward)`);
  }
  const projectRoot = projectRootFromConfigPath(configPath);
  const config = loadConfig(configPath);
  const projectDir = resolve(projectRoot, config.project.directory);

  let manager: ServiceManager;
  try {
    manager = createServiceManager();
  } catch (err) {
    if (err instanceof UnsupportedPlatformError) {
      throw new CliError(err.message);
    }
    throw err;
  }
  const redqueenBin = resolveRedqueenBinPath();
  const resolved = resolveServicePaths(config, projectDir);
  const context = buildInstallContext(resolved, redqueenBin);

  switch (sub) {
    case "install":
      await doInstall(manager, context, config, projectDir);
      return;
    case "uninstall":
      await manager.uninstall(context);
      process.stdout.write(`Service ${context.name} uninstalled.\n`);
      return;
    case "start":
      await manager.start(context);
      process.stdout.write(`Service ${context.name} started.\n`);
      return;
    case "stop":
      await manager.stop(context);
      process.stdout.write(`Service ${context.name} stopped.\n`);
      return;
    case "restart":
      await manager.restart(context);
      process.stdout.write(`Service ${context.name} restarted.\n`);
      return;
    case "status": {
      const status = await manager.status(context);
      printStatus(status);
      return;
    }
  }
}

async function doInstall(
  manager: ServiceManager,
  context: ServiceInstallContext,
  config: RedQueenConfig,
  projectDir: string,
): Promise<void> {
  mkdirSync(resolve(projectDir, ".redqueen"), { recursive: true });
  writeWrapperScript(context.wrapperScriptPath, {
    envFilePath: context.envFilePath,
    redqueenBinPath: context.redqueenBinPath,
    nodeBinPath: process.execPath,
  });
  await manager.install(context);
  printInstallBanner(context, config);
}

function printInstallBanner(context: ServiceInstallContext, config: RedQueenConfig): void {
  const { dashboard, pipeline } = config;
  const lines: string[] = [];
  lines.push(`Installed service: ${context.name}`);
  lines.push("");
  lines.push("Dashboard:");
  if (dashboard.enabled) {
    lines.push(`  http://${dashboard.host}:${String(dashboard.port)}`);
  } else {
    lines.push(`  (disabled — set dashboard.enabled: true in redqueen.yaml)`);
  }
  lines.push("");
  lines.push("Webhooks:");
  if (pipeline.webhooks.enabled) {
    if (pipeline.webhooks.publicBaseUrl !== undefined) {
      const base = pipeline.webhooks.publicBaseUrl;
      lines.push(`  ${base}${pipeline.webhooks.paths.issueTracker}`);
      lines.push(`  ${base}${pipeline.webhooks.paths.sourceControl}`);
    } else {
      lines.push(`  (pipeline.webhooks.publicBaseUrl is unset — webhook URLs unknown)`);
    }
  } else {
    lines.push(`  (disabled)`);
  }
  lines.push("");
  lines.push("Logs:");
  lines.push(`  ${context.stdoutLogPath}`);
  lines.push(`  ${context.stderrLogPath}`);
  lines.push("");
  lines.push("Next:");
  lines.push(`  1. Set env vars in ${context.envFilePath}`);
  lines.push(`  2. redqueen service start`);
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

function printStatus(status: ServiceStatus): void {
  const state =
    status.installed === false ? "not-installed" : status.running ? "running" : "stopped";
  process.stdout.write(`service: ${status.name}\n`);
  process.stdout.write(`platform: ${status.platform}\n`);
  process.stdout.write(`state: ${state}\n`);
  if (status.pid !== null) {
    process.stdout.write(`pid: ${String(status.pid)}\n`);
  }
  process.stdout.write(`stdout: ${status.stdoutLog}\n`);
  process.stdout.write(`stderr: ${status.stderrLog}\n`);
}

function printServiceHelp(): void {
  process.stdout.write(
    [
      "redqueen service — manage the background daemon",
      "",
      "Subcommands:",
      "  install      Install and enable the service (writes plist/unit + wrapper script)",
      "  start        Start the service",
      "  stop         Stop the service",
      "  restart      Restart the service",
      "  status       Show install/run state and log paths",
      "  uninstall    Stop, disable, and remove the service",
      "",
    ].join("\n"),
  );
}

/**
 * Resolve the absolute path to the redqueen CLI entry point. The wrapper
 * script invokes this directly, so it must be a stable path that survives
 * shell session differences (which might lack the user's PATH).
 */
export function resolveRedqueenBinPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev: src/cli/service.ts -> ../cli/index.ts (served by tsx in tests only)
  // Built: dist/cli/service.js -> ../cli/index.js
  const candidate = resolve(here, "index.js");
  if (existsSync(candidate)) {
    return candidate;
  }
  // Fall back to the currently-running node entry if the built bin is missing.
  // This matters when the user invokes `node dist/cli/index.js` from an unusual
  // location — the generated wrapper should still point back at the same binary.
  return process.argv[1] ?? candidate;
}
