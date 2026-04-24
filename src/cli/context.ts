import { resolve } from "node:path";
import { DualWriteAuditLogger } from "../core/audit.js";
import type { AuditLogger } from "../core/audit.js";
import type { RedQueenConfig } from "../core/config.js";
import { loadConfig } from "../core/config.js";
import { RedQueenDatabase } from "../core/database.js";
import { PipelineStateStore } from "../core/pipeline-state.js";
import type { IssueTracker } from "../integrations/issue-tracker.js";
import type { SourceControl } from "../integrations/source-control.js";
import { constructIssueTracker, constructSourceControl } from "./adapters.js";
import { findConfigUpward, projectRootFromConfigPath } from "./config-discovery.js";
import { CliError } from "./errors.js";

export interface CliContext {
  config: RedQueenConfig;
  configPath: string;
  projectRoot: string;
  issueTracker: IssueTracker;
  sourceControl: SourceControl;
  pipelineState: PipelineStateStore;
  audit: AuditLogger;
  cleanup: () => void;
}

export function loadCliContext(): CliContext {
  const configPath = findConfigUpward(process.cwd());
  if (configPath === null) {
    throw new CliError(`redqueen.yaml not found (searched from ${process.cwd()} upward)`);
  }
  const projectRoot = projectRootFromConfigPath(configPath);
  const config = loadConfig(configPath);

  // Resolve project.directory relative to the config file.
  const projectDir = resolve(projectRoot, config.project.directory);
  const dbPath = resolve(projectDir, ".redqueen", "redqueen.db");
  const auditPath = resolve(projectDir, ".redqueen", config.audit.logFile);

  const database = new RedQueenDatabase(dbPath);
  const pipelineState = new PipelineStateStore(database.db);
  const audit = new DualWriteAuditLogger(database.db, auditPath);

  const issueTracker = constructIssueTracker(config.issueTracker.type, config.issueTracker.config);
  const sourceControl = constructSourceControl(
    config.sourceControl.type,
    config.sourceControl.config,
  );

  return {
    config: { ...config, project: { ...config.project, directory: projectDir } },
    configPath,
    projectRoot,
    issueTracker,
    sourceControl,
    pipelineState,
    audit,
    cleanup: () => {
      database.close();
    },
  };
}
