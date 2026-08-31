import type { AiAssignmentState, IssueTracker } from "../integrations/issue-tracker.js";
import type { AuditLogger } from "./audit.js";
import { errorMessage } from "./errors.js";
import type { PipelineStateStore } from "./pipeline-state.js";
import type { TaskQueue } from "./queue.js";
import type { RuntimeState } from "./runtime-state.js";

export interface AssignmentRouterDeps {
  issueTracker: IssueTracker;
  queue: TaskQueue;
  runtime: RuntimeState;
  pipelineState: PipelineStateStore;
  audit: AuditLogger;
}

export interface RouteAiAssignmentOptions {
  issueId: string;
  component: string;
  description: string;
  delegator?: string | null;
  assignmentState?: AiAssignmentState;
}

export const ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY = "requiresAiAssignment";

export type AssignmentRouteReason =
  | "enqueued"
  | "already-queued"
  | "assignment-state-read-failed"
  | "issue-closed"
  | "assignment-revoked"
  | "unphased-existing-state"
  | "unknown-phase"
  | "human-gate"
  | "missing-local-state"
  | "matching-local-state";

export interface AssignmentRouteResult {
  outcome: "enqueued" | "skipped" | "deferred";
  reason: AssignmentRouteReason;
  phase: string | null;
  taskType: string | null;
}

export async function readAiAssignmentState(
  issueTracker: IssueTracker,
  issueId: string,
): Promise<AiAssignmentState> {
  if (issueTracker.getAiAssignmentState === undefined) {
    throw new Error("Issue tracker does not support live AI assignment checks");
  }
  return issueTracker.getAiAssignmentState(issueId);
}

/**
 * Route an issue assigned to the AI worker from the issue tracker's live phase.
 *
 * Webhook delivery and reconciliation deliberately share this function so a
 * missed assignment webhook produces the same task as an online assignment.
 */
export async function routeAiAssignment(
  deps: AssignmentRouterDeps,
  options: RouteAiAssignmentOptions,
): Promise<AssignmentRouteResult> {
  const { issueTracker, queue, runtime, pipelineState, audit } = deps;
  const { issueId, component, description, delegator = null } = options;
  const initialRecord = pipelineState.get(issueId);

  // The webhook actor is trusted independently of the live ownership lookup.
  // Persist it before that asynchronous read so an early exit cannot discard a
  // newer handoff target for an existing pipeline.
  if (initialRecord !== null && delegator !== null) {
    pipelineState.updateDelegator(issueId, delegator);
  }

  let assignmentState: AiAssignmentState;
  try {
    assignmentState =
      options.assignmentState ?? (await readAiAssignmentState(issueTracker, issueId));
  } catch (err) {
    // A pipeline may have been initialized while the failed read was in
    // flight. Preserve the delegator in that case as well.
    if (initialRecord === null && delegator !== null) {
      pipelineState.updateDelegator(issueId, delegator);
    }
    // The recovery sweep only re-finds unphased issues via
    // listIssuesAssignedToAi — without it this failure has no retry path.
    const retryNote =
      issueTracker.listIssuesAssignedToAi === undefined
        ? "no sweep recovery on this tracker — re-assign the issue to retry"
        : "reconciliation will retry";
    audit.log({
      component,
      issueId,
      message: `assignment-change: live assignment state read failed; ${retryNote}: ${errorMessage(err)}`,
      metadata: {},
    });
    return {
      outcome: "deferred",
      reason: "assignment-state-read-failed",
      phase: null,
      taskType: null,
    };
  }

  // The tracker read is asynchronous. Refresh local state before any further
  // early exits so a pipeline initialized while it was in flight receives the
  // delegator and is not treated as untracked.
  const record = pipelineState.get(issueId);
  if (record !== null && initialRecord === null && delegator !== null) {
    pipelineState.updateDelegator(issueId, delegator);
  }

  const currentPhase = assignmentState.phase;
  if (assignmentState.closed) {
    audit.log({
      component,
      issueId,
      message: "assignment-change: issue is closed on the tracker — no task created",
      metadata: { phase: currentPhase },
    });
    return {
      outcome: "skipped",
      reason: "issue-closed",
      phase: currentPhase,
      taskType: null,
    };
  }
  if (assignmentState.assignedToAi === false) {
    audit.log({
      component,
      issueId,
      message: "assignment-change: AI assignment was revoked before routing — no task created",
      metadata: { phase: currentPhase },
    });
    return {
      outcome: "skipped",
      reason: "assignment-revoked",
      phase: currentPhase,
      taskType: null,
    };
  }

  // A positive assignment change may be the event that clears an ownership
  // hold. Wake deferred work now; every task re-runs its own dequeue-time
  // guards, and the periodic deferred sweep remains the liveness fallback.
  queue.releaseDeferred();

  const entryPhaseNames = new Set(runtime.phaseGraph.getEntryPhases().map((phase) => phase.name));
  let taskType: string;

  if (currentPhase === null) {
    if (record !== null) {
      audit.log({
        component,
        issueId,
        message: "assignment-change: no tracker phase set — no task created",
        metadata: {},
      });
      return {
        outcome: "skipped",
        reason: "unphased-existing-state",
        phase: null,
        taskType: null,
      };
    }
    taskType = "new-ticket";
  } else if (runtime.phaseGraph.getPhase(currentPhase) === undefined) {
    audit.log({
      component,
      issueId,
      message: `assignment-change references unknown phase ${currentPhase}`,
      metadata: { phase: currentPhase },
    });
    return {
      outcome: "skipped",
      reason: "unknown-phase",
      phase: currentPhase,
      taskType: null,
    };
  } else if (runtime.phaseGraph.isHumanGate(currentPhase)) {
    audit.log({
      component,
      issueId,
      message: `assignment-change while parked at human gate ${currentPhase} — no task created`,
      metadata: { phase: currentPhase },
    });
    return {
      outcome: "skipped",
      reason: "human-gate",
      phase: currentPhase,
      taskType: null,
    };
  } else if (entryPhaseNames.has(currentPhase)) {
    // Entry phases can be re-kicked after a failed task. Open work is still
    // deduplicated below.
    taskType = currentPhase;
  } else if (record === null) {
    audit.log({
      component,
      issueId,
      message: "no local pipeline state — run new-ticket first",
      metadata: { phase: currentPhase },
    });
    return {
      outcome: "skipped",
      reason: "missing-local-state",
      phase: currentPhase,
      taskType: null,
    };
  } else if (record.currentPhase === currentPhase) {
    audit.log({
      component,
      issueId,
      message: `assignment-change: tracker phase ${currentPhase} matches local state — no task created`,
      metadata: { phase: currentPhase },
    });
    return {
      outcome: "skipped",
      reason: "matching-local-state",
      phase: currentPhase,
      taskType: null,
    };
  } else {
    taskType = currentPhase;
  }

  if (queue.hasOpenTask(issueId, taskType)) {
    return {
      outcome: "skipped",
      reason: "already-queued",
      phase: currentPhase,
      taskType,
    };
  }

  queue.enqueue({
    type: taskType,
    issueId,
    description,
    metadata: {
      [ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY]: true,
      ...(delegator === null ? {} : { delegator }),
    },
  });
  audit.log({
    component,
    issueId,
    message: `assignment-change enqueued ${taskType}`,
    metadata: { phase: currentPhase, taskType },
  });

  return {
    outcome: "enqueued",
    reason: "enqueued",
    phase: currentPhase,
    taskType,
  };
}
