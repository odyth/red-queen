import { ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY } from "./assignment-router.js";
import type { AuditLogger } from "./audit.js";
import { errorMessage } from "./errors.js";
import type { IPendingPhaseTransition, PipelineStateStore } from "./pipeline-state.js";
import type { TaskQueue } from "./queue.js";
import type { RuntimeState } from "./runtime-state.js";
import type { PhaseDefinition } from "./types.js";
import { sanitizeWorkerDiagnostic } from "./worker-diagnostics.js";
import type { IssueTracker } from "../integrations/issue-tracker.js";

interface ITransitionDeps {
  issueTracker: IssueTracker;
  pipelineState: PipelineStateStore;
  queue: TaskQueue;
  runtime: RuntimeState;
  audit: AuditLogger;
}

export type PhaseTransitionOutcome =
  | "completed"
  | "phase-pending"
  | "assignment-pending"
  | "assignment-stopped"
  | "cancelled";

const MAX_ASSIGNMENT_ATTEMPTS = 3;
const ASSIGNMENT_RETRY_DELAY_MS = 300_000;
const PHASE_RETRY_DELAY_MS = 300_000;
const MAX_PHASE_RETRY_DELAY_MS = 3_600_000;
const PHASE_FAILURE_NOTICE_ATTEMPTS = 3;

// Serializes the immediate handoff and reconciliation in this daemon. A durable
// identity also prevents stale in-flight writes from finishing a newer handoff.
const activeTransitions = new WeakMap<
  PipelineStateStore,
  Map<string, Promise<PhaseTransitionOutcome>>
>();

export async function retryPhaseTransition(
  deps: ITransitionDeps,
  issueId: string,
): Promise<PhaseTransitionOutcome> {
  let active = activeTransitions.get(deps.pipelineState);
  if (active === undefined) {
    active = new Map();
    activeTransitions.set(deps.pipelineState, active);
  }
  const existing = active.get(issueId);
  if (existing !== undefined) {
    return existing;
  }
  const work = applyTransition(deps, issueId);
  active.set(issueId, work);
  try {
    return await work;
  } finally {
    active.delete(issueId);
  }
}

// Both polling and webhooks must distinguish a return to the source from an
// echo of the source while its destination write has never been confirmed.
export function isPhaseTransitionSuperseded(
  pending: IPendingPhaseTransition,
  livePhase: string | null,
): boolean {
  return (
    livePhase !== pending.destination &&
    (pending.phaseApplied === 1 || (livePhase !== null && livePhase !== pending.sourcePhase))
  );
}

export function cancelPhaseTransition(
  deps: ITransitionDeps,
  pending: IPendingPhaseTransition,
  livePhase: string | null,
): void {
  const { pipelineState, queue, runtime, audit } = deps;
  const leavingGate = runtime.phaseGraph.isHumanGate(
    pipelineState.get(pending.issueId)?.currentPhase ?? "",
  );
  const cancelled = pipelineState.finishPhaseTransition(
    pending.issueId,
    livePhase,
    () => {
      queue.cancelPendingForIssue(pending.issueId, "Superseded by a tracker phase change", {
        preserveFeedback: true,
      });
      if (leavingGate) {
        pipelineState.resetIterations(pending.issueId);
      }
    },
    pending.id,
  );
  if (cancelled) {
    queue.releaseDeferred();
    audit.log({
      component: "orchestrator",
      issueId: pending.issueId,
      message: `Cancelled pending transition to ${pending.destination} — tracker moved to ${livePhase ?? "no phase"}`,
      metadata: {},
    });
  }
}

async function applyTransition(
  deps: ITransitionDeps,
  issueId: string,
): Promise<PhaseTransitionOutcome> {
  const { pipelineState, issueTracker, runtime, queue, audit } = deps;
  const pending = pipelineState.getPendingTransition(issueId);
  if (pending === null) {
    return "cancelled";
  }
  const stillPending = (): boolean =>
    pipelineState.getPendingTransition(issueId)?.id === pending.id;
  try {
    const livePhase = await issueTracker.getPhase(issueId);
    if (stillPending() === false) {
      return "cancelled";
    }
    // Once the phase write landed, even a return to its source supersedes it.
    // Cancellation needs only the stored names, not a still-configured target.
    if (isPhaseTransitionSuperseded(pending, livePhase)) {
      cancelPhaseTransition(deps, pending, livePhase);
      return "cancelled";
    }
    const target = runtime.phaseGraph.getPhase(pending.destination);
    if (target === undefined) {
      throw new Error(`Unknown destination ${pending.destination}`);
    }
    if (livePhase !== target.name) {
      if (pending.phaseRetryAt > Date.now()) {
        return "phase-pending";
      }
      await issueTracker.setPhase(issueId, target.name);
    }
    if (pipelineState.confirmPhaseTransition(pending, target.type === "automated") === false) {
      return "cancelled";
    }
    if (pending.assignmentAttempts >= MAX_ASSIGNMENT_ATTEMPTS) {
      return "assignment-stopped";
    }
    if (pending.assignmentRetryAt > Date.now()) {
      return "assignment-pending";
    }
    try {
      if (target.type === "human-gate") {
        await issueTracker.assignToHuman(
          issueId,
          pipelineState.get(issueId)?.delegatorAccountId ?? null,
        );
      } else {
        await issueTracker.assignToAi(issueId);
      }
    } catch (err) {
      if (stillPending() === false) {
        return "cancelled";
      }
      return await handleAssignmentFailure(deps, pending, target, errorMessage(err));
    }
    // A human may have moved the ticket during the assignment request, even
    // without webhooks. Never enqueue the old destination after that move.
    const confirmedPhase = await issueTracker.getPhase(issueId);
    if (stillPending() === false) {
      return "cancelled";
    }
    if (confirmedPhase !== target.name) {
      cancelPhaseTransition(deps, pending, confirmedPhase);
      return "cancelled";
    }
    pipelineState.finishPhaseTransition(
      issueId,
      target.name,
      () => {
        queue.cancelPendingForIssue(issueId, `Superseded by transition to ${target.name}`, {
          preserveFeedback: true,
        });
        if (target.type === "automated" && queue.hasOpenTask(issueId, target.name) === false) {
          queue.enqueue({
            type: target.name,
            issueId,
            description: `Transitioned to ${target.name}`,
            metadata:
              issueTracker.getAiAssignmentState === undefined
                ? undefined
                : { [ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY]: true },
          });
        }
      },
      pending.id,
    );
    queue.releaseDeferred();
    audit.log({
      component: "orchestrator",
      issueId,
      message: `Transitioned to ${target.name}`,
      metadata: {},
    });
    return "completed";
  } catch (err) {
    if (stillPending() === false) {
      return "cancelled";
    }
    if (pipelineState.getPendingTransition(issueId)?.phaseApplied === 0) {
      if (pending.phaseRetryAt > Date.now()) {
        return "phase-pending";
      }
      await handlePhaseFailure(deps, pending, errorMessage(err));
      if (stillPending() === false) {
        return "cancelled";
      }
    }
    audit.log({
      component: "orchestrator",
      issueId,
      message: `Transition to ${pending.destination} pending: ${errorMessage(err)}`,
      metadata: { sourcePhase: pending.sourcePhase, destination: pending.destination },
    });
    return pipelineState.getPendingTransition(issueId)?.phaseApplied === 1
      ? "assignment-pending"
      : "phase-pending";
  }
}

async function handlePhaseFailure(
  deps: ITransitionDeps,
  pending: IPendingPhaseTransition,
  error: string,
): Promise<void> {
  const { pipelineState, issueTracker, runtime, audit } = deps;
  const attempts = pending.phaseAttempts + 1;
  const delay = Math.min(
    PHASE_RETRY_DELAY_MS * 2 ** Math.min(pending.phaseAttempts, 4),
    MAX_PHASE_RETRY_DELAY_MS,
  );
  pipelineState.recordPhaseFailure(pending, Date.now() + delay);
  if (attempts < PHASE_FAILURE_NOTICE_ATTEMPTS || pending.phaseNoticePosted === 1) {
    return;
  }
  const label = runtime.phaseGraph.getPhase(pending.destination)?.label ?? pending.destination;
  try {
    await issueTracker.addComment(
      pending.issueId,
      `Red Queen: the tracker handoff to **${label}** is still failing after ${String(attempts)} attempts: ${sanitizeWorkerDiagnostic(error)}\n\nAutomatic work remains paused. Red Queen will keep retrying the handoff with backoff, up to one hour between attempts. Repair the tracker access or phase configuration; a manual move to another phase takes precedence. No worker is restarted by these retries.`,
    );
    pipelineState.markPhaseNoticePosted(pending);
  } catch (err) {
    audit.log({
      component: "orchestrator",
      issueId: pending.issueId,
      message: `Could not post phase handoff failure notice: ${errorMessage(err)}`,
      metadata: {},
    });
  }
}

async function handleAssignmentFailure(
  deps: ITransitionDeps,
  pending: IPendingPhaseTransition,
  target: PhaseDefinition,
  error: string,
): Promise<PhaseTransitionOutcome> {
  const { pipelineState, queue, audit, issueTracker } = deps;
  const attempts = pending.assignmentAttempts + 1;
  const stopped = attempts >= MAX_ASSIGNMENT_ATTEMPTS;
  if (stopped && target.type === "human-gate") {
    pipelineState.finishPhaseTransition(
      pending.issueId,
      target.name,
      () => {
        queue.cancelPendingForIssue(pending.issueId, "Assignment recovery exhausted", {
          preserveFeedback: true,
        });
      },
      pending.id,
    );
  } else {
    pipelineState.recordAssignmentFailure(
      pending,
      stopped ? 0 : Date.now() + ASSIGNMENT_RETRY_DELAY_MS * 2 ** (attempts - 1),
    );
  }
  audit.log({
    component: "orchestrator",
    issueId: pending.issueId,
    message: `Assignment to ${target.assignTo} for ${target.name} ${stopped ? "stopped" : "pending"}: ${error}`,
    metadata: { attempts, destination: target.name },
  });
  if (attempts === 1 || stopped) {
    const recovery =
      target.type === "automated"
        ? `Repair the assignment, then run \`redqueen pipeline resume ${pending.issueId}\`. Reassigning this ticket to AI also recovers the handoff when assignment webhooks are enabled and delivered. Polling-only deployments must use \`pipeline resume\`.`
        : "Assign this ticket to an available human. A manual move to another phase takes precedence.";
    const status = stopped
      ? `Automatic assignment retries stopped after ${String(attempts)} attempts.`
      : `Assignment will be retried with backoff, up to ${String(MAX_ASSIGNMENT_ATTEMPTS)} attempts.`;
    try {
      await issueTracker.addComment(
        pending.issueId,
        `Red Queen: the assignment handoff for **${target.label}** failed: ${sanitizeWorkerDiagnostic(error)}\n\n${status} ${recovery}`,
      );
    } catch (err) {
      audit.log({
        component: "orchestrator",
        issueId: pending.issueId,
        message: `Could not post assignment failure notice: ${errorMessage(err)}`,
        metadata: {},
      });
    }
  }
  // Posting the notice also yields to manual recovery. Do not let failOver
  // describe an obsolete handoff after the human has moved the ticket.
  const current = pipelineState.getPendingTransition(pending.issueId);
  if (stopped && target.type === "human-gate") {
    if (current !== null || pipelineState.get(pending.issueId)?.currentPhase !== target.name) {
      return "cancelled";
    }
  } else if (current?.id !== pending.id) {
    return "cancelled";
  }
  return stopped ? "assignment-stopped" : "assignment-pending";
}
