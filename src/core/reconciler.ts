import {
  ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY,
  readAiAssignmentState,
  routeAiAssignment,
} from "./assignment-router.js";
import type { AuditLogger } from "./audit.js";
import { errorMessage } from "./errors.js";
import type { PipelineStateStore } from "./pipeline-state.js";
import type { TaskQueue } from "./queue.js";
import type { RuntimeState } from "./runtime-state.js";
import type { AiAssignmentState, Issue, IssueTracker } from "../integrations/issue-tracker.js";
import type { Task, TaskStatus } from "./types.js";

const ASSIGNMENT_RECOVERY_READ_CONCURRENCY = 8;
const OPEN_TASK_STATUSES: readonly TaskStatus[] = ["ready", "working", "deferred"];

interface AssignmentRecoveryRead {
  issue: Issue;
  state: AiAssignmentState | null;
  error: string | null;
}

export interface ReconcilerDeps {
  issueTracker: IssueTracker;
  queue: TaskQueue;
  runtime: RuntimeState;
  pipelineState: PipelineStateStore;
  audit: AuditLogger;
}

export interface ReconcileResult {
  issuesFound: number;
  tasksCreated: number;
  skipped: number;
}

export async function reconcile(deps: ReconcilerDeps): Promise<ReconcileResult> {
  const { issueTracker, queue, runtime, pipelineState, audit } = deps;
  let issuesFound = 0;
  let tasksCreated = 0;
  let skipped = 0;

  const openGuardedNewTickets = collectOpenGuardedNewTickets(queue);
  const seenIssueIds = new Set<string>();
  const automatedPhases = runtime.phaseGraph.getAutomatedPhases();
  const entryPhaseNames = new Set(runtime.phaseGraph.getEntryPhases().map((p) => p.name));

  for (const phase of automatedPhases) {
    let issues;
    try {
      issues = await issueTracker.listIssuesByPhase(phase.name);
    } catch (err) {
      audit.log({
        component: "reconciler",
        issueId: null,
        message: `Failed to list issues for phase ${phase.name}: ${errorMessage(err)}`,
        metadata: { phase: phase.name },
      });
      continue;
    }

    for (const issue of issues) {
      if (seenIssueIds.has(issue.id)) {
        continue;
      }
      seenIssueIds.add(issue.id);
      issuesFound++;

      if (queue.hasOpenTask(issue.id, phase.name)) {
        skipped++;
        continue;
      }

      // A guarded new-ticket can have a live phase selected while it waits.
      // Preserve that ownership hold until new-ticket revalidation can transfer
      // its metadata. Other cross-phase work remains an independent trigger.
      const guardedTask = openGuardedNewTickets.get(issue.id) ?? null;
      if (guardedTask !== null) {
        skipped++;
        audit.log({
          component: "reconciler",
          issueId: issue.id,
          message: `Skipping ${phase.name} reconciliation — assignment-guarded ${guardedTask.type} task is still open`,
          metadata: { phase: phase.name, guardedTaskId: guardedTask.id },
        });
        continue;
      }

      const record = pipelineState.get(issue.id);
      // Merge replay runs before tracker reconciliation. If the tracker still
      // reports the same automated phase that was active when the PR merged,
      // do not recreate work for the completed run. A deliberate re-entry to a
      // different phase remains eligible.
      if (
        record?.currentPhase === "done" &&
        record.prNumber === null &&
        record.priorPhase === phase.name
      ) {
        skipped++;
        audit.log({
          component: "reconciler",
          issueId: issue.id,
          message: `Skipping ${phase.name} reconciliation — its PR merge was already processed`,
          metadata: { phase: phase.name },
        });
        continue;
      }

      if (entryPhaseNames.has(phase.name) === false) {
        if (record === null) {
          skipped++;
          audit.log({
            component: "reconciler",
            issueId: issue.id,
            message: "no local pipeline state — run new-ticket first",
            metadata: { phase: phase.name },
          });
          continue;
        }
      }

      queue.enqueue({
        type: phase.name,
        issueId: issue.id,
        description: `Reconciled on startup — ${phase.label}`,
      });
      tasksCreated++;
      audit.log({
        component: "reconciler",
        issueId: issue.id,
        message: `Enqueued ${phase.name} task (reconciled)`,
        metadata: { phase: phase.name },
      });
    }
  }

  // An assignment webhook can be the only signal for a brand-new ticket that
  // has no Red Queen phase yet. Run this after the phase sweep so a stale
  // assignment-search snapshot cannot hide newer, phase-tagged work.
  if (issueTracker.listIssuesAssignedToAi !== undefined) {
    let assignedIssues: Issue[] = [];
    try {
      assignedIssues = await issueTracker.listIssuesAssignedToAi();
    } catch (err) {
      audit.log({
        component: "reconciler",
        issueId: null,
        message: `Failed to list issues assigned to AI: ${errorMessage(err)}`,
        metadata: {},
      });
    }

    const recoveryCandidates: Issue[] = [];
    for (const issue of assignedIssues) {
      if (seenIssueIds.has(issue.id)) {
        continue;
      }
      seenIssueIds.add(issue.id);
      issuesFound++;
      // GitHub's active-label listing includes issues parked at human gates.
      // Their snapshot phase is enough to skip them here — live routing would
      // only rediscover the gate after one tracker read per issue per sweep.
      // A gate exit missed by this snapshot is caught by its webhook or the
      // next sweep's phase listing.
      if (issue.phase !== null && runtime.phaseGraph.isHumanGate(issue.phase)) {
        skipped++;
        continue;
      }
      recoveryCandidates.push(issue);
    }

    // Read remote claim state concurrently, then apply routing effects in the
    // original discovery order so queue insertion remains deterministic.
    for (
      let offset = 0;
      offset < recoveryCandidates.length;
      offset += ASSIGNMENT_RECOVERY_READ_CONCURRENCY
    ) {
      const batch = recoveryCandidates.slice(offset, offset + ASSIGNMENT_RECOVERY_READ_CONCURRENCY);
      const reads = await Promise.all(
        batch.map(async (issue): Promise<AssignmentRecoveryRead> => {
          try {
            return {
              issue,
              state: await readAiAssignmentState(issueTracker, issue.id),
              error: null,
            };
          } catch (err) {
            return { issue, state: null, error: errorMessage(err) };
          }
        }),
      );

      for (const read of reads) {
        if (read.state === null) {
          skipped++;
          audit.log({
            component: "reconciler",
            issueId: read.issue.id,
            message: `assignment-change: live assignment state read failed; reconciliation will retry: ${read.error ?? "unknown error"}`,
            metadata: {},
          });
          continue;
        }

        const routeResult = await routeAiAssignment(deps, {
          issueId: read.issue.id,
          component: "reconciler",
          description: "Recovered missed AI assignment",
          assignmentState: read.state,
        });
        if (routeResult.outcome === "enqueued") {
          tasksCreated++;
        } else {
          skipped++;
        }
      }
    }
  }

  // Every sweep re-evaluates parked tasks: releaseDeferred is the liveness
  // backstop for state changes no webhook reported (link edits, manual moves).
  queue.releaseDeferred();

  audit.log({
    component: "reconciler",
    issueId: null,
    message: `Reconciliation complete: ${String(issuesFound)} issues found, ${String(tasksCreated)} tasks created, ${String(skipped)} skipped`,
    metadata: { issuesFound, tasksCreated, skipped },
  });

  return { issuesFound, tasksCreated, skipped };
}

function collectOpenGuardedNewTickets(queue: TaskQueue): Map<string, Task> {
  const claims = new Map<string, Task>();
  for (const status of OPEN_TASK_STATUSES) {
    for (const task of queue.listByStatus(status)) {
      if (
        task.issueId !== null &&
        task.type === "new-ticket" &&
        task.metadata[ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY] === true &&
        claims.has(task.issueId) === false
      ) {
        claims.set(task.issueId, task);
      }
    }
  }
  return claims;
}
