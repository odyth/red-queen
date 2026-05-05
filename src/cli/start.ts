import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DualWriteAuditLogger } from "../core/audit.js";
import { buildPhaseGraph, loadConfig, validatePhaseGraph } from "../core/config.js";
import { RedQueenDatabase } from "../core/database.js";
import { loadDotEnv } from "../core/env.js";
import { RedQueen } from "../core/orchestrator.js";
import { OrchestratorStateStore, PipelineStateStore } from "../core/pipeline-state.js";
import { SqliteTaskQueue } from "../core/queue.js";
import { RuntimeState } from "../core/runtime-state.js";
import {
  buildInstallContext,
  createServiceManager,
  resolveServicePaths,
  UnsupportedPlatformError,
} from "../core/service/index.js";
import type { ServiceInstallContext, ServiceManager } from "../core/service/index.js";
import { packageVersion } from "../core/version.js";
import { buildAdapterPair } from "./adapters.js";
import { findConfigUpward, projectRootFromConfigPath } from "./config-discovery.js";
import { CliError } from "./errors.js";
import { removePidFile, resolvePidPath, tryClaimPidFile } from "./pid.js";
import { resolveRedqueenBinPath } from "./service.js";
import { resolveSkillsDir } from "./templates.js";

export async function cmdStart(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      verbose: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    process.stdout.write(
      "redqueen start — run the orchestrator (foreground). Flags: --verbose --quiet\n",
    );
    return;
  }

  const configPath = findConfigUpward(process.cwd());
  if (configPath === null) {
    throw new CliError(`redqueen.yaml not found (searched from ${process.cwd()} upward)`);
  }
  const projectRoot = projectRootFromConfigPath(configPath);
  const envResult = loadDotEnv(dirname(configPath));
  for (const warning of envResult.warnings) {
    process.stderr.write(`warning (.env): ${warning}\n`);
  }
  const config = loadConfig(configPath);
  const projectDir = resolve(projectRoot, config.project.directory);

  const phaseValidation = validatePhaseGraph(config.phases);
  for (const warning of phaseValidation.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  if (phaseValidation.errors.length > 0) {
    throw new CliError(
      `Invalid phase configuration:\n${phaseValidation.errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
  const phaseGraph = buildPhaseGraph(config.phases);

  const pidPath = resolvePidPath(projectDir);
  mkdirSync(dirname(pidPath), { recursive: true });
  let claim = tryClaimPidFile(pidPath);
  if (claim.ok === false) {
    if (claim.stale === false) {
      throw new CliError(
        `redqueen is already running (pid ${String(claim.existingPid)}). Stop it with 'redqueen stop' or remove ${pidPath} if it is stale.`,
      );
    }
    removePidFile(pidPath);
    claim = tryClaimPidFile(pidPath);
    if (claim.ok === false) {
      throw new CliError(
        `redqueen start raced with another start (pid ${String(claim.existingPid)}). Try again.`,
      );
    }
  }

  const dbPath = resolve(projectDir, ".redqueen", "redqueen.db");
  const auditPath = resolve(projectDir, ".redqueen", config.audit.logFile);

  let database: RedQueenDatabase;
  try {
    database = new RedQueenDatabase(dbPath);
  } catch (err) {
    removePidFile(pidPath);
    throw err;
  }
  const queue = new SqliteTaskQueue(database.db);
  const pipelineState = new PipelineStateStore(database.db);
  const orchestratorState = new OrchestratorStateStore(database.db);
  const audit = new DualWriteAuditLogger(database.db, auditPath);

  const adapterPair = buildAdapterPair(
    {
      issueTrackerType: config.issueTracker.type,
      issueTrackerConfig: config.issueTracker.config,
      sourceControlType: config.sourceControl.type,
      sourceControlConfig: config.sourceControl.config,
    },
    { configDir: dirname(configPath) },
  );
  const { issueTracker, sourceControl } = adapterPair;

  const itValidation = issueTracker.validateConfig(config.issueTracker.config);
  for (const warning of itValidation.warnings) {
    process.stderr.write(`warning (issueTracker): ${warning}\n`);
  }
  if (itValidation.errors.length > 0) {
    database.close();
    removePidFile(pidPath);
    throw new CliError(
      `issueTracker config invalid:\n${itValidation.errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
  try {
    sourceControl.validateConfig(config.sourceControl.config);
  } catch (err) {
    database.close();
    removePidFile(pidPath);
    throw new CliError(
      `sourceControl config invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const phaseMapping = issueTracker.validatePhaseMapping(phaseGraph.getPhaseNames());
  for (const warning of phaseMapping.warnings) {
    process.stderr.write(`warning (phase mapping): ${warning}\n`);
  }

  try {
    await withTimeout(adapterPair.warmup(), 2000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAuthError(message)) {
      database.close();
      removePidFile(pidPath);
      throw new CliError(`adapter auth failed: ${message}`);
    }
    process.stderr.write(`warning (adapter reachability): ${message} — proceeding anyway\n`);
  }

  if (values.quiet !== true) {
    printBanner({
      projectDir,
      dbPath,
      dashboard: {
        host: config.dashboard.host,
        port: config.dashboard.port,
        enabled: config.dashboard.enabled,
      },
      webhooks: {
        enabled: config.pipeline.webhooks.enabled,
        publicBaseUrl: config.pipeline.webhooks.publicBaseUrl ?? null,
        paths: config.pipeline.webhooks.paths,
      },
      pid: process.pid,
    });
  }

  const configForRuntime = {
    ...config,
    project: { ...config.project, directory: projectDir },
    audit: { ...config.audit, logFile: auditPath },
  };
  const runtime = new RuntimeState(phaseGraph, configForRuntime);

  let serviceManager: ServiceManager | undefined;
  let serviceContext: ServiceInstallContext | undefined;
  try {
    serviceManager = createServiceManager();
    serviceContext = buildInstallContext(
      resolveServicePaths(config, projectDir),
      resolveRedqueenBinPath(),
    );
  } catch (err) {
    if (err instanceof UnsupportedPlatformError === false) {
      throw err;
    }
    // Unsupported platform — dashboard simply won't expose service controls.
  }

  const rq = new RedQueen({
    runtime,
    queue,
    pipelineState,
    orchestratorState,
    audit,
    issueTracker,
    sourceControl,
    builtInSkillsDir: resolveSkillsDir(),
    installSignalHandlers: true,
    serviceManager,
    serviceContext,
  });

  try {
    await rq.start();
  } finally {
    removePidFile(pidPath);
    database.close();
  }
}

interface BannerInput {
  projectDir: string;
  dbPath: string;
  dashboard: { host: string; port: number; enabled: boolean };
  webhooks: {
    enabled: boolean;
    publicBaseUrl: string | null;
    paths: { issueTracker: string; sourceControl: string };
  };
  pid: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

function isAuthError(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("auth failed") ||
    lowered.includes("authentication") ||
    lowered.includes("401") ||
    lowered.includes("403")
  );
}

function printBanner(input: BannerInput): void {
  const dash = input.dashboard.enabled
    ? `http://${input.dashboard.host}:${String(input.dashboard.port)}`
    : "disabled";
  process.stdout.write(`Red Queen v${packageVersion()} [preview]\n`);
  process.stdout.write(`  project:   ${input.projectDir}\n`);
  process.stdout.write(`  database:  ${input.dbPath}\n`);
  process.stdout.write(`  dashboard: ${dash}\n`);
  process.stdout.write(`  webhooks:  ${input.webhooks.enabled ? "enabled" : "disabled"}\n`);
  process.stdout.write(`  pid:       ${String(input.pid)}\n`);
  if (input.webhooks.enabled) {
    const localBase = `http://${input.dashboard.host}:${String(input.dashboard.port)}`;
    process.stdout.write(
      `  issue-tracker webhook:  ${localBase}${input.webhooks.paths.issueTracker}\n`,
    );
    process.stdout.write(
      `  source-control webhook: ${localBase}${input.webhooks.paths.sourceControl}\n`,
    );
    if (input.webhooks.publicBaseUrl !== null) {
      const pub = input.webhooks.publicBaseUrl;
      process.stdout.write(
        `  (paste into issue tracker): ${pub}${input.webhooks.paths.issueTracker}\n`,
      );
      process.stdout.write(
        `  (paste into source control): ${pub}${input.webhooks.paths.sourceControl}\n`,
      );
    }
  }
}
