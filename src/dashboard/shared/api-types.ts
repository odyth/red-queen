// Wire-format types shared between the dashboard server and the browser
// controller bundle. Server handlers type their JSON responses against
// these interfaces, and the client's fetch wrappers parse into them —
// so a rename on either side breaks tsc on both.
//
// Only include fields the client actually reads. Keep this module
// dependency-free (no Node imports, no core/* imports) so it can be
// bundled for the browser.

import type { PhaseDefinition } from "../../core/types.js";

export type { PhaseDefinition };

// --- Task / status ---

export type TaskStatusWire = "ready" | "working" | "complete" | "failed";

export interface TaskSummary {
  id: string;
  type: string;
  priority: number;
  issueId: string | null;
  status: TaskStatusWire;
  description: string | null;
  createdAt: string;
  startedAt: string | null;
}

export type OrchestratorStatus = "idle" | "working" | "stopped" | "crashed";

export interface StatusPayload {
  status: OrchestratorStatus;
  currentTaskId: string | null;
  lastPoll: string | null;
  completedCount: number;
  errorCount: number;
  startedAt: string | null;
  readyCount: number;
  workingCount: number;
  currentTask: TaskSummary | null;
}

// --- Logs ---

export interface AuditEntryWire {
  timestamp: string;
  component: string;
  issueId: string | null;
  message: string;
}

// --- Config ---

export interface EnvRef {
  name: string;
  set: boolean;
}

export interface ConfigGetResponse {
  yaml: string;
  envRefs: EnvRef[];
}

export interface ConfigValidateResponse {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface ConfigPutOk {
  ok: true;
  applied: string[];
  restartRequired: string[];
}

export interface ConfigPutFail {
  ok: false;
  errors: string[];
  warnings: string[];
}

export type ConfigPutResponse = ConfigPutOk | ConfigPutFail;

// --- Skills ---

export type SkillOrigin = "bundled" | "user" | "both";

export interface SkillEntry {
  name: string;
  origin: SkillOrigin;
  disabled: boolean;
  referencedBy: string[];
}

export interface SkillGetResponse {
  name: string;
  content: string;
}

export interface SkillMutateOk {
  ok: true;
  name: string;
}

export interface SkillMutateFail {
  error?: string;
  message?: string;
}

// --- Workflow ---

export interface WorkflowGetResponse {
  phases: PhaseDefinition[];
  entryPhases: string[];
  humanGates: string[];
  warnings: string[];
}

export interface WorkflowValidateResponse {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface WorkflowPutOk {
  ok: true;
  applied: string[];
  restartRequired: string[];
}

export interface WorkflowPutFail {
  ok: false;
  errors: string[];
  warnings: string[];
}

export interface WorkflowPutConflict {
  readyCount: number;
  workingCount: number;
  message: string;
}

export type WorkflowPutResponse = WorkflowPutOk | WorkflowPutFail | WorkflowPutConflict;

// --- SSE events ---
//
// Each DashboardEvent.type determines the shape of .data. The union
// below lets the client narrow payloads by event name.

export interface WorkerStartedPayload {
  taskId: string;
  issueId: string | null;
  taskType: string;
  phaseLabel: string;
  startedAt: string;
}

export interface WorkerHeartbeatPayload {
  taskId: string;
  pid: number;
  elapsed: number;
  cpuPercent: string;
  rssKb: string;
  cpuTime: string;
  idleSeconds: number;
}

export interface WorkerCompletedPayload {
  taskId: string;
  issueId: string | null;
  taskType: string;
  phaseLabel: string;
  elapsed: number;
  success: boolean;
  summary: string;
}

export interface QueueChangedPayload {
  readyCount: number;
  workingCount: number;
}

export interface OrchestratorStatusPayload {
  status: OrchestratorStatus;
  completedCount: number;
  errorCount: number;
}

export interface ConfigReloadedPayload {
  applied: string[];
  restartRequired: string[];
}

export interface DashboardEventMap {
  "worker:started": WorkerStartedPayload;
  "worker:heartbeat": WorkerHeartbeatPayload;
  "worker:completed": WorkerCompletedPayload;
  "queue:changed": QueueChangedPayload;
  "orchestrator:status": OrchestratorStatusPayload;
  "config:reloaded": ConfigReloadedPayload;
}

export type DashboardEventName = keyof DashboardEventMap;
