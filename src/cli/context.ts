import { resolve } from "node:path";
import { DualWriteAuditLogger } from "../core/audit.js";
import type { AuditLogger } from "../core/audit.js";
import { resolveProjectPaths } from "../core/config.js";
import type { RedQueenConfig } from "../core/config.js";
import { RedQueenDatabase } from "../core/database.js";
import { PipelineStateStore } from "../core/pipeline-state.js";
import { SubIterationStore } from "../core/sub-iteration.js";
import type { IssueTracker } from "../integrations/issue-tracker.js";
import type { SourceControlRegistry } from "../integrations/source-control-registry.js";
import { buildAdapterPair } from "./adapters.js";
import { loadConfigFromProject } from "./config-discovery.js";

export interface CliContext {
  config: RedQueenConfig;
  configPath: string;
  projectRoot: string;
  issueTracker: IssueTracker;
  sourceControls: SourceControlRegistry;
  pipelineState: PipelineStateStore;
  subIteration: SubIterationStore;
  audit: AuditLogger;
  cleanup: () => void;
}

export function loadCliContext(): CliContext {
  const loaded = loadConfigFromProject(process.cwd());
  const config = resolveProjectPaths(loaded.config, loaded.projectRoot);
  const projectDir = config.project.directory;
  const dbPath = resolve(projectDir, ".redqueen", "redqueen.db");
  const auditPath = resolve(projectDir, ".redqueen", config.audit.logFile);

  const database = new RedQueenDatabase(dbPath);
  const repoNames = config.project.repos.map((r) => r.name);
  const pipelineState = new PipelineStateStore(database.db, repoNames);
  const subIteration = new SubIterationStore(database.db);
  const audit = new DualWriteAuditLogger(database.db, auditPath);
  // Helpers may run before the first `start` on an upgraded install; adopt
  // legacy rows here too so per-row reads see them. Idempotent.
  const primary = repoNames[0];
  if (primary !== undefined) {
    pipelineState.adoptLegacyRows(primary, config.project.workspaceMode === false);
  }
  // Helpers enforce the state/config agreement the daemon does at start, but
  // only the daemon may re-key: this config can be ahead of a running one.
  try {
    pipelineState.assertRepoNames(config.project.workspaceMode === false);
  } catch (err) {
    database.close();
    throw err;
  }

  const pair = buildAdapterPair(
    {
      issueTrackerType: config.issueTracker.type,
      issueTrackerConfig: config.issueTracker.config,
      sourceControlType: config.sourceControl.type,
      sourceControlConfig: config.sourceControl.config,
      repos: config.project.repos,
      workspaceMode: config.project.workspaceMode,
    },
    {
      configDir: loaded.configDir,
      audit: (message, metadata) => {
        audit.log({ component: "github-issues", issueId: null, message, metadata });
      },
    },
  );

  return {
    config,
    configPath: loaded.configPath,
    projectRoot: loaded.projectRoot,
    issueTracker: pair.issueTracker,
    sourceControls: pair.sourceControls,
    pipelineState,
    subIteration,
    audit,
    cleanup: () => {
      database.close();
    },
  };
}
