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
  SkillModuleContext,
  PipelineEventSource,
  PipelineEventType,
  PipelineEvent,
  Comment,
  ValidationResult,
} from "./core/types.js";
export { PhaseGraph } from "./core/types.js";

// Config
export type { RedQueenConfig, ProjectModule } from "./core/config.js";
export {
  loadConfig,
  parseConfig,
  validatePhaseGraph,
  buildPhaseGraph,
  ConfigSchema,
  PhaseDefinitionSchema,
} from "./core/config.js";

// Interfaces
export type { Issue, IssueTracker, Attachment } from "./integrations/issue-tracker.js";
export type {
  CreatePROptions,
  PullRequest,
  SourceControl,
  CheckStatus,
  CheckConclusion,
} from "./integrations/source-control.js";

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

// Orchestrator
export { RedQueen } from "./core/orchestrator.js";
export type { RedQueenDeps, WorkerRunner } from "./core/orchestrator.js";

// Worker
export { runWorker, resolveClaudeBin } from "./core/worker.js";
export type { WorkerOptions, WorkerResult, HeartbeatInfo } from "./core/worker.js";

// Skill context
export { buildSkillContext, renderSkillPrompt, resolveSkillPath } from "./core/skill-context.js";
export type { SkillContextDeps, ModuleResolver } from "./core/skill-context.js";
export { createModuleResolver } from "./core/module-resolver.js";
export type { ResolveModuleOptions } from "./core/module-resolver.js";

// Reconciler / Poller
export { reconcile } from "./core/reconciler.js";
export type { ReconcilerDeps, ReconcileResult } from "./core/reconciler.js";
export { Poller } from "./core/poller.js";
export type { PollerDeps } from "./core/poller.js";

// Dashboard
export { DashboardServer } from "./dashboard/server.js";
export type { DashboardDeps, DashboardServerOptions, RouteHandler } from "./dashboard/server.js";
export { SSEManager } from "./dashboard/events.js";
export type { DashboardEvent, DashboardEventType } from "./dashboard/events.js";

// Webhook
export { WebhookServer } from "./webhook/server.js";
export type { WebhookServerDeps } from "./webhook/server.js";
