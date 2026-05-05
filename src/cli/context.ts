import { resolve } from "node:path";
import { DualWriteAuditLogger } from "../core/audit.js";
import type { AuditLogger } from "../core/audit.js";
import type { RedQueenConfig } from "../core/config.js";
import { RedQueenDatabase } from "../core/database.js";
import { PipelineStateStore } from "../core/pipeline-state.js";
import type { IssueTracker } from "../integrations/issue-tracker.js";
import type { SourceControl } from "../integrations/source-control.js";
import { buildAdapterPair } from "./adapters.js";
import { loadConfigFromProject } from "./config-discovery.js";

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
  const { config, configPath, configDir, projectRoot } = loadConfigFromProject(process.cwd());

  // Resolve project.directory relative to the config file.
  const projectDir = resolve(projectRoot, config.project.directory);
  const dbPath = resolve(projectDir, ".redqueen", "redqueen.db");
  const auditPath = resolve(projectDir, ".redqueen", config.audit.logFile);

  const database = new RedQueenDatabase(dbPath);
  const pipelineState = new PipelineStateStore(database.db);
  const audit = new DualWriteAuditLogger(database.db, auditPath);

  const pair = buildAdapterPair(
    {
      issueTrackerType: config.issueTracker.type,
      issueTrackerConfig: config.issueTracker.config,
      sourceControlType: config.sourceControl.type,
      sourceControlConfig: config.sourceControl.config,
    },
    { configDir },
  );

  return {
    config: { ...config, project: { ...config.project, directory: projectDir } },
    configPath,
    projectRoot,
    issueTracker: pair.issueTracker,
    sourceControl: pair.sourceControl,
    pipelineState,
    audit,
    cleanup: () => {
      database.close();
    },
  };
}
