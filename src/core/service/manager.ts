import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { RedQueenConfig } from "../config.js";

export type ServicePlatform = "darwin" | "linux";

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  name: string;
  pid: number | null;
  platform: ServicePlatform;
  stdoutLog: string;
  stderrLog: string;
}

export interface ServiceInstallContext {
  name: string;
  workingDirectory: string;
  envFilePath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  wrapperScriptPath: string;
  redqueenBinPath: string;
  restart: "on-failure" | "always" | "never";
}

export abstract class ServiceManager {
  abstract readonly platform: ServicePlatform;
  abstract install(context: ServiceInstallContext): Promise<void>;
  abstract uninstall(context: ServiceInstallContext): Promise<void>;
  abstract start(context: ServiceInstallContext): Promise<void>;
  abstract stop(context: ServiceInstallContext): Promise<void>;
  abstract restart(context: ServiceInstallContext): Promise<void>;
  abstract status(context: ServiceInstallContext): Promise<ServiceStatus>;
}

export function computeServiceName(projectDir: string, override?: string): string {
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const hash = createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 8);
  return `sh.redqueen.${hash}`;
}

export interface ResolvedServicePaths {
  name: string;
  workingDirectory: string;
  envFilePath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  wrapperScriptPath: string;
  restart: "on-failure" | "always" | "never";
}

export function resolveServicePaths(
  config: RedQueenConfig,
  projectDir: string,
): ResolvedServicePaths {
  const workingDirectory = resolve(projectDir, config.service.workingDirectory ?? ".");
  const envFilePath = resolve(projectDir, config.service.envFile);
  const stdoutLogPath = resolve(projectDir, config.service.stdoutLog);
  const stderrLogPath = resolve(projectDir, config.service.stderrLog);
  const wrapperScriptPath = resolve(projectDir, ".redqueen", "run-redqueen.sh");
  return {
    name: computeServiceName(projectDir, config.service.name),
    workingDirectory,
    envFilePath,
    stdoutLogPath,
    stderrLogPath,
    wrapperScriptPath,
    restart: config.service.restart,
  };
}
