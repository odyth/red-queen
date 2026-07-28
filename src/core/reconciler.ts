import type { AuditLogger } from "./audit.js";
import { errorMessage } from "./errors.js";
import type { PipelineStateStore } from "./pipeline-state.js";
import type { TaskQueue } from "./queue.js";
import type { RuntimeState } from "./runtime-state.js";
import type { IssueTracker } from "../integrations/issue-tracker.js";

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
