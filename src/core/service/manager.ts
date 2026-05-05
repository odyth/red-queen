import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { RedQueenConfig } from "../config.js";

export type ServicePlatform = "darwin" | "linux" | "unsupported";

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

/**
 * Pull a stdout payload off an error thrown by `promisify(execFile)` without
 * tripping the `no-base-to-string` lint. Returns "" when the shape is wrong.
 */
export function extractStdout(err: unknown): string {
  if (err === null || typeof err !== "object") {
    return "";
  }
  const raw = (err as { stdout?: unknown }).stdout;
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Buffer) {
    return raw.toString("utf8");
  }
  return "";
}

export class ServicePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServicePathError";
  }
}

function assertNoControlChars(field: string, value: string): void {
  // systemd .service files are line-oriented — a newline in any path would
  // inject an extra directive. launchd plists XML-escape, but we still refuse
  // on principle: no legitimate service path contains control characters.
  // eslint-disable-next-line no-control-regex
  if (/[\n\r\t\0\x1b]/.test(value)) {
    throw new ServicePathError(
      `service.${field} contains a control character (newline/CR/tab/NUL/ESC); refusing to generate unit/plist`,
    );
  }
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

  assertNoControlChars("workingDirectory", workingDirectory);
  assertNoControlChars("envFile", envFilePath);
  assertNoControlChars("stdoutLog", stdoutLogPath);
  assertNoControlChars("stderrLog", stderrLogPath);
  assertNoControlChars("wrapperScriptPath", wrapperScriptPath);

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
