// Core types
export type {
  PhaseType,
  AssignTo,
  PhaseDefinition,
  TaskStatus,
  Task,
  NewTask,
  PipelineRecord,
  OrchestratorStatus,
  OrchestratorState,
  SkillContext,
  PipelineEventSource,
  PipelineEventType,
  PipelineEvent,
  Comment,
  ValidationResult,
} from "./core/types.js";
export { PhaseGraph } from "./core/types.js";

// Config
export type { RedQueenConfig } from "./core/config.js";
export {
  loadConfig,
  parseConfig,
  validatePhaseGraph,
  buildPhaseGraph,
  ConfigSchema,
  PhaseDefinitionSchema,
} from "./core/config.js";

// Interfaces
export type { Issue, IssueTracker } from "./integrations/issue-tracker.js";
export type { CreatePROptions, PullRequest, SourceControl } from "./integrations/source-control.js";

// Audit
export type { AuditEntry, AuditFilter, AuditLogger } from "./core/audit.js";
export { DualWriteAuditLogger } from "./core/audit.js";

// Queue
export type { TaskQueue } from "./core/queue.js";
export { SqliteTaskQueue } from "./core/queue.js";

// Database
export { RedQueenDatabase } from "./core/database.js";

// Pipeline state
export { PipelineStateStore, OrchestratorStateStore } from "./core/pipeline-state.js";

// Defaults
export { DEFAULT_PHASES } from "./core/defaults.js";

// Orchestrator stub
export { RedQueen } from "./core/orchestrator.js";
