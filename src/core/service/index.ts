import { LinuxServiceManager } from "./linux.js";
import { MacServiceManager } from "./macos.js";
import {
  resolveServicePaths,
  type ResolvedServicePaths,
  type ServiceInstallContext,
  type ServiceManager,
} from "./manager.js";
import type { RedQueenConfig } from "../config.js";

export {
  ServiceManager,
  ServicePathError,
  extractStdout,
  resolveServicePaths,
  computeServiceName,
  type ResolvedServicePaths,
  type ServiceInstallContext,
  type ServicePlatform,
  type ServiceStatus,
} from "./manager.js";
export { MacServiceManager, renderPlist, plistPathFor, readInstalledPlist } from "./macos.js";
export { LinuxServiceManager, renderUnit, unitPathFor, readInstalledUnit } from "./linux.js";
export { renderWrapperScript, writeWrapperScript, shellSingleQuote } from "./wrapper.js";

export class UnsupportedPlatformError extends Error {
  constructor(platform: NodeJS.Platform) {
    super(
      `Red Queen service installer does not support platform "${platform}". Supported: darwin, linux (user mode).`,
    );
    this.name = "UnsupportedPlatformError";
  }
}

export function createServiceManager(platform: NodeJS.Platform = process.platform): ServiceManager {
  if (platform === "darwin") {
    return new MacServiceManager();
  }
  if (platform === "linux") {
    return new LinuxServiceManager();
  }
  throw new UnsupportedPlatformError(platform);
}

export function buildInstallContext(
  resolved: ResolvedServicePaths,
  redqueenBinPath: string,
): ServiceInstallContext {
  return {
    name: resolved.name,
    workingDirectory: resolved.workingDirectory,
    envFilePath: resolved.envFilePath,
    stdoutLogPath: resolved.stdoutLogPath,
    stderrLogPath: resolved.stderrLogPath,
    wrapperScriptPath: resolved.wrapperScriptPath,
    redqueenBinPath,
    restart: resolved.restart,
  };
}

export function contextFromConfig(
  config: RedQueenConfig,
  projectDir: string,
  redqueenBinPath: string,
): ServiceInstallContext {
  return buildInstallContext(resolveServicePaths(config, projectDir), redqueenBinPath);
}
