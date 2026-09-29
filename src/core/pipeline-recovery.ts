import {
  ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY,
  readAiAssignmentState,
} from "./assignment-router.js";
import type { AuditLogger } from "./audit.js";
import { errorMessage } from "./errors.js";
import type { PipelineStateStore } from "./pipeline-state.js";
import type { TaskQueue } from "./queue.js";
import type { PhaseGraph, Task } from "./types.js";
import type { IssueTracker } from "../integrations/issue-tracker.js";

interface IRecoveryDeps {
  issueTracker: IssueTracker;
  pipelineState: PipelineStateStore;
  queue: TaskQueue;
  phaseGraph: PhaseGraph;
  audit: AuditLogger;
}

export async function resumePipeline(deps: IRecoveryDeps, issueId: string): Promise<Task> {
  const { issueTracker, pipelineState, queue, phaseGraph, audit } = deps;
  const live = await readAiAssignmentState(issueTracker, issueId);
  if (live.closed || live.phase === null || phaseGraph.getPhase(live.phase)?.type !== "automated") {
    throw new Error(
      "Resume requires an open ticket in a configured automated phase; human gates must be moved manually",
    );
  }
  const phase = live.phase;
  const pending = pipelineState.getPendingTransition(issueId);
  if (pending !== null && (pending.phaseApplied === 0 || pending.destination !== phase)) {
    throw new Error("A phase transition is still pending; repair the tracker write first");
  }
  if (pipelineState.isPhaseExhausted(issueId, phase) === false && pending === null) {
    throw new Error(`Phase ${phase} is not exhausted`);
  }
  const assertNoConflictingTask = (): void => {
    for (const status of ["ready", "working", "deferred"] as const) {
      if (
        queue
          .listByStatus(status)
          .some(
            (task) =>
              task.issueId === issueId &&
              (status === "working" ||
                task.type === phase ||
                (task.metadata.trigger !== "pr-feedback" && task.description !== "PR feedback")),
          )
      ) {
        throw new Error("This ticket already has an open task");
      }
    }
  };
  // Preserve unrelated queued feedback, including work parked behind this
  // handoff. Commit the guarded resume before changing tracker ownership.
  const task = pipelineState.resumePhase(
    issueId,
    phase,
    () => {
      assertNoConflictingTask();
      return queue.enqueue({
        type: phase,
        issueId,
        description: "Explicitly resumed after exhaustion",
        metadata: { [ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY]: true },
      });
    },
    pending?.id ?? null,
  );
  audit.log({
    component: "pipeline",
    issueId,
    message: `Queued explicit resume for ${phase} with a fresh attempt budget`,
    metadata: { taskId: task.id },
  });
  try {
    await issueTracker.assignToAi(issueId);
  } catch (err) {
    throw new Error(
      `Resume task ${task.id} was saved, but AI assignment failed: ${errorMessage(err)}. Assign this ticket to AI manually; the saved task will recheck ownership before running.`,
      { cause: err },
    );
  }
  return task;
}
