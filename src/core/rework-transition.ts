import type { AuditLogger } from "./audit.js";
import type { PipelineStateStore } from "./pipeline-state.js";
import type { PhaseGraph } from "./types.js";
import type { IssueTracker } from "../integrations/issue-tracker.js";

export interface ReworkTransitionContext {
  issueTracker: Pick<IssueTracker, "setPhase" | "assignToAi">;
  pipelineState: Pick<PipelineStateStore, "get" | "updatePhase">;
  phaseGraph: PhaseGraph;
  audit: AuditLogger;
}

/**
 * Deterministically move a ticket parked at a human gate into its rework phase
 * and hand it back to the AI (setPhase + local commit + assignToAi).
 *
 * Returns "skip" — touching no tracker state — unless `currentPhase` is a phase
 * whose `rework` target is exactly `targetPhase` and that target's `requiresPr`
 * guard matches the ticket's PR state. Only human gates declare `rework`, so an
 * automated phase the orchestrator is actively working never matches: the guard
 * is what keeps this from racing the dispatch path.
 *
 * Shared by the orchestrator's preDispatchValidation and the pr-feedback webhook
 * so a human's feedback flips assignment + status the instant it lands, while the
 * orchestrator re-running this at dispatch is a safe, idempotent no-op.
 */
export async function autoTransitionRework(
  ctx: ReworkTransitionContext,
  issueId: string,
  currentPhase: string,
  targetPhase: string,
  component: string,
  metadata: Record<string, unknown>,
): Promise<"transitioned" | "skip"> {
  const gate = ctx.phaseGraph.getPhase(currentPhase);
  if (gate?.rework !== targetPhase) {
    return "skip";
  }
  const requiresPr = ctx.phaseGraph.getPhase(targetPhase)?.requiresPr;
  if (requiresPr !== undefined) {
    const record = ctx.pipelineState.get(issueId);
    const hasPr = record !== null && record.prNumber !== null;
    if (requiresPr === true && hasPr === false) {
      return "skip";
    }
    if (requiresPr === false && hasPr === true) {
      return "skip";
    }
  }
  try {
    await ctx.issueTracker.setPhase(issueId, targetPhase);
  } catch (err) {
    ctx.audit.log({
      component,
      issueId,
      message: `Auto-transition ${currentPhase} -> ${targetPhase} failed: ${errorMessage(err)}`,
      metadata: { ...metadata, from: currentPhase, to: targetPhase },
    });
    return "skip";
  }
  // setPhase succeeded — commit the transition locally. assignToAi is an ops
  // signal (the tracker assignee); a failure there does not undo the phase
  // change, so we still report "transitioned" rather than apparent silence.
  ctx.pipelineState.updatePhase(issueId, targetPhase);
  try {
    await ctx.issueTracker.assignToAi(issueId);
  } catch (err) {
    ctx.audit.log({
      component,
      issueId,
      message: `Auto-transition ${currentPhase} -> ${targetPhase}: assignToAi failed after setPhase succeeded: ${errorMessage(err)}`,
      metadata: { ...metadata, from: currentPhase, to: targetPhase },
    });
  }
  ctx.audit.log({
    component,
    issueId,
    message: `Auto-transitioned ${currentPhase} -> ${targetPhase} for rework`,
    metadata: { ...metadata, from: currentPhase, to: targetPhase },
  });
  return "transitioned";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
