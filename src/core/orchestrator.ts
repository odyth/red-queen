import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeAudit } from "./audit.js";
import type { AuditLogger } from "./audit.js";
import {
  ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY,
  readAiAssignmentState,
} from "./assignment-router.js";
import { withTimeout } from "./async.js";
import { buildPhaseGraph } from "./config.js";
import type { RedQueenConfig } from "./config.js";
import type { OrchestratorStateStore, PipelineStateStore } from "./pipeline-state.js";
import type { PhaseUsageStore } from "./phase-usage.js";
import { computeCost } from "./cost.js";
import { errorMessage } from "./errors.js";
import { buildFailureNotice } from "./failure-notice.js";
import { Poller } from "./poller.js";
import type { TaskQueue } from "./queue.js";
import { reconcile } from "./reconciler.js";
import { autoTransitionRework } from "./rework-transition.js";
import { createModuleResolver } from "./module-resolver.js";
import type { RuntimeState } from "./runtime-state.js";
import { bareBaseBranch, resolveStack, terminalGateNames } from "./stack.js";
import type { StackResolution } from "./stack.js";
import type { ServiceInstallContext, ServiceManager } from "./service/index.js";
import {
  buildSkillContext,
  buildSkillSearchDirs,
  renderSkillPrompt,
  resolveSkillPath,
} from "./skill-context.js";
import type { ModuleResolver } from "./skill-context.js";
import type { PhaseDefinition, Task } from "./types.js";
import type { OrchestratorState } from "./types.js";
import { resolveAgentBin, resolveAgentSettings, runWorker as defaultRunWorker } from "./worker.js";
import type { WorkerOptions, WorkerResult } from "./worker.js";
import type { AiAssignmentState, IssueTracker } from "../integrations/issue-tracker.js";
import type { SourceControl } from "../integrations/source-control.js";
import { DashboardServer } from "../dashboard/server.js";
import { WebhookServer } from "../webhook/server.js";

export type WorkerRunner = (options: WorkerOptions) => Promise<WorkerResult>;

type AssignmentClaimValidation =
  | { action: "proceed"; state: AiAssignmentState | null }
  | { action: "stop" };

export interface ReloadResult {
  applied: string[];
  restartRequired: string[];
}

export interface RedQueenDeps {
  runtime: RuntimeState;
  queue: TaskQueue;
  pipelineState: PipelineStateStore;
  phaseUsage: PhaseUsageStore;
  orchestratorState: OrchestratorStateStore;
  audit: AuditLogger;
  issueTracker: IssueTracker;
  sourceControl: SourceControl;
  workerRunner?: WorkerRunner;
  builtInSkillsDir?: string;
  moduleResolver?: ModuleResolver;
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  phaseWatchIntervalMs?: number;
  phaseDriftGraceMs?: number;
  installSignalHandlers?: boolean;
  serviceManager?: ServiceManager;
  serviceContext?: ServiceInstallContext;
  configPath?: string;
  projectRoot?: string;
}

// How often the in-flight phase watch re-reads the tracker phase while a worker
// runs. A worker can run for many minutes; one tracker read per tick (single
// active worker at a time) is negligible.
const PHASE_WATCH_INTERVAL_MS = 15_000;
// How long a tracker phase must stay drifted off the running phase before the watch
// aborts the worker. A worker's last act is often a self-route via `set-phase`; it
// then takes a few seconds to emit its final JSON and exit, during which the tracker
// reads as drifted. The grace lets that wrap-up finish (the worker exits and the
// watch is torn down) so only a persistent drift — a human moving the ticket while
// the worker grinds on now-moot work — actually aborts.
const PHASE_DRIFT_GRACE_MS = 30_000;
// How often the main loop prunes the audit log (DB rows + flat file) to the
// configured retention window. Coarse on purpose — pruning is maintenance,
// not a state transition, so it runs off the main loop rather than any phase.
const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_MERGE_SCAN_TIMEOUT_MS = 30_000;
const ASSIGNMENT_CHECK_ERROR_BLOCKER = "<assignment-check-error>";
const AI_ASSIGNMENT_REQUIRED_BLOCKER = "<ai-assignment-required>";

export class RedQueen {
  private readonly deps: RedQueenDeps;
  private readonly runWorker: WorkerRunner;
  private readonly moduleResolver: ModuleResolver;
  private readonly sleep: (ms: number) => Promise<void>;
  private dashboard: DashboardServer | null = null;
  private webhook: WebhookServer | null = null;
  private poller: Poller | null = null;
  private shuttingDown = false;
  private shutdownCount = 0;
  private currentWorkerPid: number | null = null;
  private mainLoopPromise: Promise<void> | null = null;
  private signalHandlersInstalled = false;
  private sigHandler: ((sig: NodeJS.Signals) => void) | null = null;
  private stopPromise: Promise<void> | null = null;
  private tempDir: string | null = null;
  private lastAuditPruneMs = 0;
  private lastDeferredReleaseMs = 0;

  constructor(deps: RedQueenDeps) {
    this.deps = deps;
    this.runWorker = deps.workerRunner ?? defaultRunWorker;
    this.moduleResolver =
      deps.moduleResolver ??
      createModuleResolver({
        onGitError: (message) => {
          deps.audit.log({
            component: "module-resolver",
            issueId: null,
            message,
            metadata: {},
          });
        },
      });
    this.sleep =
      deps.sleepFn ??
      ((ms) =>
        new Promise((resolveSleep) => {
          setTimeout(resolveSleep, ms);
        }));
  }

  async start(): Promise<void> {
    // Live under the project's .redqueen/ instead of the OS tmp dir: systemd-tmpfiles
    // reaps /tmp entries after ~10 days, deleting it under a long-running daemon. The
    // per-write mkdirSync in dispatchWorkerForTask self-heals it if it vanishes anyway.
    this.tempDir = join(this.deps.runtime.config.project.directory, ".redqueen", "tmp");
    this.performCrashRecovery();

    await this.startDashboardIfEnabled();
    this.setupWebhookServer();

    if (this.deps.installSignalHandlers === true) {
      this.installSignalHandlers();
    }

    const startupMergeScan = this.webhook?.reconcileMergedPrs();
    if (startupMergeScan !== undefined) {
      try {
        await withTimeout(
          startupMergeScan,
          STARTUP_MERGE_SCAN_TIMEOUT_MS,
          "Startup merged-PR reconciliation",
        );
      } catch (err) {
        safeAudit(this.deps.audit, {
          component: "orchestrator",
          issueId: null,
          message: `Startup merged-PR reconciliation failed: ${errorMessage(err)}`,
          metadata: {},
        });
      }
    }

    if (this.isShuttingDown()) {
      await this.stopPromise;
      return;
    }

    try {
      await reconcile({
        issueTracker: this.deps.issueTracker,
        queue: this.deps.queue,
        runtime: this.deps.runtime,
        pipelineState: this.deps.pipelineState,
        audit: this.deps.audit,
      });
    } catch (err) {
      safeAudit(this.deps.audit, {
        component: "orchestrator",
        issueId: null,
        message: `Startup reconciliation failed: ${errorMessage(err)}`,
        metadata: {},
      });
    }

    if (this.isShuttingDown()) {
      await this.stopPromise;
      return;
    }

    this.startPollerIfConfigured();

    const nowIso = new Date(this.now()).toISOString();
    this.deps.orchestratorState.setStatus("idle");
    this.deps.orchestratorState.setStartedAt(nowIso);
    this.emitDashboardStatus();

    this.mainLoopPromise = this.mainLoop();
    await this.mainLoopPromise;
    if (this.stopPromise !== null) {
      await this.stopPromise;
    }
  }

  async stop(): Promise<void> {
    this.shutdownCount++;
    this.shuttingDown = true;

    if (this.shutdownCount > 1 && this.currentWorkerPid !== null) {
      killWorkerPid(this.currentWorkerPid, "SIGTERM");
    }

    this.poller?.stop();
    this.stopPromise ??= this.performStop();
    await this.stopPromise;
  }

  private async performStop(): Promise<void> {
    if (this.mainLoopPromise !== null) {
      try {
        await this.mainLoopPromise;
      } catch {
        // Errors handled inside main loop
      }
    }

    const webhook = this.webhook;
    if (webhook !== null) {
      try {
        await webhook.drain();
      } catch (err) {
        safeAudit(this.deps.audit, {
          component: "orchestrator",
          issueId: null,
          message: `Merged-PR reconciliation drain failed during shutdown: ${errorMessage(err)}`,
          metadata: {},
        });
      }
      this.webhook = null;
    }
    if (this.dashboard !== null) {
      try {
        await this.dashboard.stop();
      } catch {
        // Server already closed
      }
      this.dashboard = null;
    }

    this.uninstallSignalHandlers();
    this.removeTempDir();
    this.deps.orchestratorState.setStatus("stopped");
    this.deps.orchestratorState.setCurrentTaskId(null);
  }

  getStatus(): OrchestratorState {
    return this.deps.orchestratorState.get();
  }

  reload(newConfig: RedQueenConfig): ReloadResult {
    // Build the new graph first so a bad config throws before any state mutates.
    const newGraph = buildPhaseGraph(newConfig.phases);
    const oldConfig = this.deps.runtime.config;
    const applied: string[] = [];
    const restartRequired: string[] = [];

    if (JSON.stringify(oldConfig.phases) !== JSON.stringify(newConfig.phases)) {
      applied.push("phases");
    }
    if (oldConfig.skills.directory !== newConfig.skills.directory) {
      applied.push("skills.directory");
    }
    if (JSON.stringify(oldConfig.skills.disabled) !== JSON.stringify(newConfig.skills.disabled)) {
      applied.push("skills.disabled");
    }
    if (oldConfig.audit.retentionDays !== newConfig.audit.retentionDays) {
      applied.push("audit.retentionDays");
    }

    if (JSON.stringify(oldConfig.issueTracker) !== JSON.stringify(newConfig.issueTracker)) {
      restartRequired.push("issueTracker");
    }
    if (JSON.stringify(oldConfig.sourceControl) !== JSON.stringify(newConfig.sourceControl)) {
      restartRequired.push("sourceControl");
    }
    if (JSON.stringify(oldConfig.pipeline) !== JSON.stringify(newConfig.pipeline)) {
      restartRequired.push("pipeline");
    }
    if (JSON.stringify(oldConfig.service) !== JSON.stringify(newConfig.service)) {
      restartRequired.push("service");
    }
    if (
      oldConfig.dashboard.port !== newConfig.dashboard.port ||
      oldConfig.dashboard.host !== newConfig.dashboard.host
    ) {
      restartRequired.push("dashboard.listener");
    }

    // Order matters — mutate the graph first so any observer reading both
    // fields sees a consistent (graph, config) pair.
    this.deps.runtime.phaseGraph = newGraph;
    this.deps.runtime.config = newConfig;

    this.deps.audit.log({
      component: "orchestrator",
      issueId: null,
      message: `Config reloaded: applied=[${applied.join(",")}] restartRequired=[${restartRequired.join(",")}]`,
      metadata: { applied, restartRequired },
    });

    if (this.dashboard !== null) {
      this.dashboard.emit({
        type: "config:reloaded",
        data: { applied, restartRequired },
      });
    }

    return { applied, restartRequired };
  }

  private async mainLoop(): Promise<void> {
    const pollIntervalMs = this.deps.runtime.config.pipeline.pollInterval * 1000;
    while (this.shuttingDown === false) {
      this.deps.orchestratorState.setLastPoll(new Date(this.now()).toISOString());
      this.maybePruneAudit();
      this.maybeReleaseDeferred();
      let task: Task | null;
      try {
        task = this.deps.queue.dequeue();
      } catch (err) {
        this.deps.audit.log({
          component: "orchestrator",
          issueId: null,
          message: `Dequeue failed: ${errorMessage(err)}`,
          metadata: {},
        });
        await this.sleep(pollIntervalMs);
        continue;
      }

      if (task === null) {
        await this.sleep(pollIntervalMs);
        continue;
      }

      try {
        await this.processTask(task);
      } catch (err) {
        this.deps.audit.log({
          component: "orchestrator",
          issueId: task.issueId,
          message: `Task processing crashed: ${errorMessage(err)}`,
          metadata: { taskId: task.id, type: task.type },
        });
        this.deps.queue.markWorking(task.id);
        this.deps.queue.markFailed(task.id, errorMessage(err));
        this.deps.orchestratorState.incrementErrors();
        this.deps.orchestratorState.setStatus("idle");
        this.deps.orchestratorState.setCurrentTaskId(null);
      }
    }
  }

  private async processTask(task: Task): Promise<void> {
    if (task.issueId === null) {
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markFailed(task.id, "Task has no issueId");
      this.deps.audit.log({
        component: "orchestrator",
        issueId: null,
        message: `Task ${task.id} missing issueId — marked failed`,
        metadata: { taskId: task.id, type: task.type },
      });
      return;
    }

    const assignmentClaim = await this.revalidateAssignmentClaim(task);
    if (assignmentClaim.action === "stop") {
      return;
    }

    // If pipeline_state's last phase was a human-gate, we're leaving it now.
    // Reset iteration counters so reopens/reworks start fresh. Lives at the
    // top of processTask so it fires once per gate-leave regardless of source
    // (webhook phase-change / pr-feedback / assignment-change / new-ticket,
    // poller, reconciler) — none of those paths mutate current_phase before
    // enqueueing, so reading the record here still sees the gate.
    const gateLeavePhase = this.deps.pipelineState.get(task.issueId)?.currentPhase ?? null;
    if (gateLeavePhase !== null && this.deps.runtime.phaseGraph.isHumanGate(gateLeavePhase)) {
      this.deps.pipelineState.resetIterations(task.issueId);
      this.deps.audit.log({
        component: "orchestrator",
        issueId: task.issueId,
        message: `Leaving human gate ${gateLeavePhase} — reset iteration counters`,
        metadata: {
          taskId: task.id,
          fromGate: gateLeavePhase,
          toPhase: task.type,
        },
      });
    }

    if (task.type === "new-ticket") {
      await this.processNewTicketTask(task, assignmentClaim.state);
      return;
    }

    const phaseName = task.type;
    const phase = this.deps.runtime.phaseGraph.getPhase(phaseName);
    if (phase === undefined) {
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markFailed(task.id, `Unknown phase: ${phaseName}`);
      this.deps.audit.log({
        component: "orchestrator",
        issueId: task.issueId,
        message: `Unknown phase ${phaseName} — task failed`,
        metadata: { taskId: task.id },
      });
      return;
    }

    if (phase.type === "human-gate") {
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markComplete(task.id, `Phase ${phaseName} is a human gate`);
      this.deps.audit.log({
        component: "orchestrator",
        issueId: task.issueId,
        message: `Skipping task for human gate phase ${phaseName}`,
        metadata: { taskId: task.id },
      });
      return;
    }

    if (phase.skill === undefined) {
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markFailed(task.id, `Phase ${phaseName} has no skill`);
      return;
    }

    const validation = await this.preDispatchValidation(task, phaseName, assignmentClaim.state);
    if (validation === "stale") {
      return;
    }

    // Staleness wins over deferral: a task for a phase the ticket already
    // left should die as stale, not park as deferred.
    const stackGate = await this.guardStackBlockers(task, phase);
    if (stackGate.action === "deferred") {
      return;
    }

    if (
      phase.requiresSpec === true &&
      (await this.guardRequiresSpec(task, phase)) === "kicked-back"
    ) {
      return;
    }

    if (this.deps.queue.markWorking(task.id) === false) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId: task.issueId,
        message: `Skipping ${phase.name} task because it is no longer ready`,
        metadata: { taskId: task.id },
      });
      return;
    }
    await this.dispatchWorkerForTask(task, phase, stackGate.stack);
  }

  // Dequeue-time stack gate: a task whose issue has unsatisfied blockers parks
  // as 'deferred' without launching a worker. Re-evaluated fresh on every
  // dispatch attempt — link edits, merges, and gate arrivals are all picked up
  // the next time the task is released back to ready.
  private async guardStackBlockers(
    task: Task,
    phase: PhaseDefinition,
  ): Promise<{ action: "proceed"; stack: StackResolution | null } | { action: "deferred" }> {
    const issueId = task.issueId;
    if (issueId === null) {
      return { action: "proceed", stack: null };
    }

    let resolution: StackResolution;
    try {
      resolution = await resolveStack(
        issueId,
        bareBaseBranch(this.deps.runtime.config.pipeline.baseBranch),
        {
          getBlockedBy: (id) => this.deps.issueTracker.getBlockedBy(id),
          getPipelineRecord: (id) => this.deps.pipelineState.get(id),
          getTrackerPhase: (id) => this.deps.issueTracker.getPhase(id),
          terminalGates: terminalGateNames(this.deps.runtime.phaseGraph),
        },
      );
    } catch (err) {
      // Fail-closed on purpose: fail-open would start genuinely blocked work.
      // The deferred-release sweep retries in ≤5 min.
      const blockedOn = ["<resolve-error>"];
      const changed = JSON.stringify(task.blockedOn) !== JSON.stringify(blockedOn);
      this.deps.queue.markDeferred(task.id, blockedOn);
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Stack resolution failed — deferring ${phase.name}: ${errorMessage(err)}`,
        metadata: { taskId: task.id, phase: phase.name },
      });
      // Permanent failures (deleted issue, revoked access) retry forever and
      // are otherwise invisible on the tracker — surface the park once,
      // deduped via the stored blocked_on like the cycle comment below.
      if (changed) {
        try {
          await this.deps.issueTracker.addComment(
            issueId,
            `Red Queen: this issue is parked — dependency resolution failed: ${errorMessage(err)}. It will retry automatically; fix the dependency links or tracker access to unpark it.`,
          );
        } catch (commentErr) {
          this.deps.audit.log({
            component: "orchestrator",
            issueId,
            message: `Failed to post resolve-error comment: ${errorMessage(commentErr)}`,
            metadata: { taskId: task.id },
          });
        }
      }
      this.emitQueueChanged();
      return { action: "deferred" };
    }

    if (resolution.directBlockers.length === 0) {
      return { action: "proceed", stack: null };
    }
    if (resolution.ok) {
      // All blockers merged/closed with nothing to assemble → behave exactly
      // like a non-stacked issue (branch from base, no stack context).
      if (resolution.mergeBranches.length === 0) {
        return { action: "proceed", stack: null };
      }
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Stack resolved: merging [${resolution.mergeBranches.join(", ")}], PR base ${resolution.prBase}`,
        metadata: { taskId: task.id, phase: phase.name },
      });
      return { action: "proceed", stack: resolution };
    }

    const blockedOn = [
      ...resolution.unsatisfied,
      ...resolution.problems.map((p) => p.issueId),
      ...(resolution.cycle === null ? [] : ["<cycle>"]),
    ];
    const changed = JSON.stringify(task.blockedOn) !== JSON.stringify(blockedOn);
    this.deps.queue.markDeferred(task.id, blockedOn);
    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: `Deferred ${phase.name} — blocked on [${blockedOn.join(", ")}]`,
      metadata: { taskId: task.id, phase: phase.name, blockedOn },
    });

    // One tracker comment per park-state change, deduped via the stored
    // blocked_on column — plain waits included: pre-dispatch already moved
    // the ticket into the phase and assigned the AI, so a silent park reads
    // as "in progress" on the tracker for however long the blockers sit.
    if (changed) {
      const lines: string[] = ["Red Queen: this issue is parked by its dependencies."];
      if (resolution.cycle !== null) {
        lines.push(`- Dependency cycle: ${resolution.cycle.join(" → ")}`);
      }
      for (const problem of resolution.problems) {
        lines.push(`- ${problem.issueId}: ${problem.detail} (${problem.kind})`);
      }
      if (resolution.unsatisfied.length > 0) {
        lines.push(`- Waiting on: ${resolution.unsatisfied.join(", ")}`);
      }
      try {
        await this.deps.issueTracker.addComment(issueId, lines.join("\n"));
      } catch (err) {
        this.deps.audit.log({
          component: "orchestrator",
          issueId,
          message: `Failed to post stack-blocked comment: ${errorMessage(err)}`,
          metadata: { taskId: task.id },
        });
      }
    }
    this.emitQueueChanged();
    return { action: "deferred" };
  }

  private async revalidateAssignmentClaim(task: Task): Promise<AssignmentClaimValidation> {
    if (task.metadata[ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY] !== true) {
      return { action: "proceed", state: null };
    }

    const issueId = task.issueId;
    if (issueId === null) {
      return { action: "proceed", state: null };
    }

    let state: AiAssignmentState;
    try {
      state = await readAiAssignmentState(this.deps.issueTracker, issueId);
    } catch (err) {
      // Keep the guarded task open so a transient tracker outage cannot turn
      // the claim into a terminal failure that reconciliation replaces with an
      // unguarded phase task. The deferred-release sweep retries this same task.
      if (this.deps.queue.markDeferred(task.id, [ASSIGNMENT_CHECK_ERROR_BLOCKER])) {
        this.deps.orchestratorState.incrementErrors();
      }
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `AI assignment revalidation failed closed — task deferred for retry: ${errorMessage(err)}`,
        metadata: { taskId: task.id, type: task.type },
      });
      this.emitQueueChanged();
      return { action: "stop" };
    }

    if (state.assignedToAi) {
      // A phase change is an independent trigger. If the guarded claim waited
      // long enough for the issue to move elsewhere, retire the old claim
      // instead of letting pre-dispatch reset the tracker to its stale phase.
      // new-ticket is the exception: it transfers its guard to the live phase.
      if (task.type !== "new-ticket" && state.phase !== task.type) {
        if (this.deps.queue.markWorking(task.id)) {
          this.deps.queue.markComplete(
            task.id,
            `Stale — guarded claim moved to ${state.phase ?? "no phase"}`,
          );
        }
        this.deps.audit.log({
          component: "orchestrator",
          issueId,
          message: `Skipping stale assignment-guarded ${task.type} task — issue is in ${state.phase ?? "no phase"}`,
          metadata: { taskId: task.id, type: task.type, phase: state.phase },
        });
        this.emitQueueChanged();
        return { action: "stop" };
      }
      return { action: "proceed", state };
    }

    // Revocation is a durable ownership hold, not completion. Keeping the
    // claim task deferred prevents phase reconciliation from laundering it
    // into an unguarded replacement. A later assignment event or deferred
    // sweep revalidates the same task before any worker may run.
    this.deps.queue.markDeferred(task.id, [AI_ASSIGNMENT_REQUIRED_BLOCKER]);
    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: "Deferring recovered task because its AI assignment was revoked",
      metadata: { taskId: task.id, type: task.type, phase: state.phase },
    });
    this.emitQueueChanged();
    return { action: "stop" };
  }

  private async processNewTicketTask(
    task: Task,
    assignmentState: AiAssignmentState | null,
  ): Promise<void> {
    const issueId = task.issueId;
    if (issueId === null) {
      return;
    }

    let livePhase: string | null;
    if (assignmentState !== null) {
      livePhase = assignmentState.phase;
    } else {
      try {
        livePhase = await this.deps.issueTracker.getPhase(issueId);
      } catch (err) {
        if (this.deps.queue.markWorking(task.id)) {
          this.deps.queue.markFailed(task.id, `Phase revalidation failed: ${errorMessage(err)}`);
          this.deps.orchestratorState.incrementErrors();
        }
        this.deps.audit.log({
          component: "orchestrator",
          issueId,
          message: `new-ticket phase revalidation failed closed: ${errorMessage(err)}`,
          metadata: { taskId: task.id },
        });
        this.emitQueueChanged();
        return;
      }
    }

    // Assignment recovery snapshots an unphased ticket, but the task can wait
    // behind older work. Never reset a phase selected while it was queued.
    if (livePhase !== null) {
      if (this.deps.queue.markWorking(task.id) === false) {
        this.deps.audit.log({
          component: "orchestrator",
          issueId,
          message: "new-ticket revalidation stopped because the task is no longer ready",
          metadata: { taskId: task.id, phase: livePhase },
        });
        return;
      }
      const phase = this.deps.runtime.phaseGraph.getPhase(livePhase);
      const isEntryPhase = this.deps.runtime.phaseGraph
        .getEntryPhases()
        .some((entry) => entry.name === livePhase);
      const hasLocalState = this.deps.pipelineState.get(issueId) !== null;
      const canRouteExistingPhase = phase?.type === "automated" && (isEntryPhase || hasLocalState);
      if (canRouteExistingPhase && this.deps.queue.hasOpenTask(issueId, livePhase) === false) {
        this.deps.queue.enqueue({
          type: livePhase,
          issueId,
          description: `Recovered live phase ${phase.label}`,
          metadata: task.metadata,
        });
      }
      this.deps.queue.markComplete(task.id, `Skipped — issue is already in ${livePhase}`);
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: canRouteExistingPhase
          ? `new-ticket revalidation found ${livePhase} — routed the live phase without resetting it`
          : `new-ticket revalidation found ${livePhase} — skipped initialization`,
        metadata: { taskId: task.id, phase: livePhase },
      });
      this.emitQueueChanged();
      return;
    }

    if (this.deps.queue.markWorking(task.id) === false) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: "new-ticket initialization stopped because the task is no longer ready",
        metadata: { taskId: task.id },
      });
      return;
    }
    this.deps.orchestratorState.setCurrentTaskId(task.id);
    this.deps.orchestratorState.setStatus("working");

    const firstPhase = this.deps.runtime.phaseGraph.getAllPhases()[0];
    if (firstPhase === undefined) {
      this.deps.queue.markFailed(task.id, "No phases configured");
      this.deps.orchestratorState.setStatus("idle");
      this.deps.orchestratorState.setCurrentTaskId(null);
      return;
    }

    try {
      await this.deps.issueTracker.setPhase(issueId, firstPhase.name);
      if (task.metadata[ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY] !== true) {
        await this.deps.issueTracker.assignToAi(issueId);
      }
    } catch (err) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `new-ticket failed to set initial phase: ${errorMessage(err)}`,
        metadata: { taskId: task.id, phase: firstPhase.name },
      });
      this.deps.queue.markFailed(task.id, errorMessage(err));
      this.deps.orchestratorState.incrementErrors();
      this.deps.orchestratorState.setStatus("idle");
      this.deps.orchestratorState.setCurrentTaskId(null);
      return;
    }

    const delegator = typeof task.metadata.delegator === "string" ? task.metadata.delegator : null;
    const existingRecord = this.deps.pipelineState.get(issueId);
    if (existingRecord === null) {
      this.deps.pipelineState.create(issueId, firstPhase.name, delegator);
    } else {
      this.deps.pipelineState.updatePhase(issueId, firstPhase.name);
      if (delegator !== null) {
        this.deps.pipelineState.updateDelegator(issueId, delegator);
      }
    }

    if (this.deps.queue.hasOpenTask(issueId, firstPhase.name) === false) {
      this.deps.queue.enqueue({
        type: firstPhase.name,
        issueId,
        description: `Initial ${firstPhase.label} task`,
        metadata:
          task.metadata[ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY] === true
            ? task.metadata
            : undefined,
      });
    }

    this.deps.queue.markComplete(task.id, `Initialized pipeline at ${firstPhase.name}`);
    this.deps.orchestratorState.incrementCompleted();
    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: `Initialized new ticket at phase ${firstPhase.name}`,
      metadata: { taskId: task.id },
    });
    this.deps.orchestratorState.setStatus("idle");
    this.deps.orchestratorState.setCurrentTaskId(null);
    this.emitDashboardStatus();
    this.emitQueueChanged();
  }

  private async preDispatchValidation(
    task: Task,
    phaseName: string,
    assignmentState: AiAssignmentState | null,
  ): Promise<"proceed" | "stale"> {
    const issueId = task.issueId;
    if (issueId === null) {
      return "proceed";
    }

    let currentPhase: string | null;
    if (assignmentState !== null) {
      currentPhase = assignmentState.phase;
    } else {
      try {
        currentPhase = await this.deps.issueTracker.getPhase(issueId);
      } catch (err) {
        this.deps.audit.log({
          component: "orchestrator",
          issueId,
          message: `Pre-dispatch phase read failed: ${errorMessage(err)}`,
          metadata: { taskId: task.id, phase: phaseName },
        });
        await this.syncSpecFromTracker(issueId, phaseName, task.id);
        return "proceed";
      }
    }

    if (currentPhase === phaseName) {
      await this.syncSpecFromTracker(issueId, phaseName, task.id);
      return "proceed";
    }

    if (currentPhase !== null && this.deps.runtime.phaseGraph.isHumanGate(currentPhase)) {
      const reworkResult = await this.tryAutoTransitionRework(
        issueId,
        currentPhase,
        phaseName,
        task,
      );
      if (reworkResult === "transitioned") {
        await this.syncSpecFromTracker(issueId, phaseName, task.id);
        return "proceed";
      }
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markComplete(task.id, `Stale — issue is in ${currentPhase} (human gate)`);
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Skipping stale ${phaseName} task — issue is in ${currentPhase} (human gate)`,
        metadata: { taskId: task.id, currentPhase, expectedPhase: phaseName },
      });
      this.emitQueueChanged();
      return "stale";
    }

    try {
      await this.deps.issueTracker.setPhase(issueId, phaseName);
      if (task.metadata[ASSIGNMENT_CLAIM_REQUIRED_METADATA_KEY] !== true) {
        await this.deps.issueTracker.assignToAi(issueId);
      }
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Pre-dispatch: set phase to ${phaseName} (was ${currentPhase ?? "unset"})`,
        metadata: { taskId: task.id, previousPhase: currentPhase },
      });
    } catch (err) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Pre-dispatch phase sync failed: ${errorMessage(err)}`,
        metadata: { taskId: task.id, expectedPhase: phaseName },
      });
    }

    await this.syncSpecFromTracker(issueId, phaseName, task.id);
    return "proceed";
  }

  private tryAutoTransitionRework(
    issueId: string,
    currentPhase: string,
    targetPhase: string,
    task: Task,
  ): Promise<"transitioned" | "skip"> {
    return autoTransitionRework(
      {
        issueTracker: this.deps.issueTracker,
        pipelineState: this.deps.pipelineState,
        phaseGraph: this.deps.runtime.phaseGraph,
        audit: this.deps.audit,
      },
      issueId,
      currentPhase,
      targetPhase,
      "orchestrator",
      { taskId: task.id },
    );
  }

  private async syncSpecFromTracker(
    issueId: string,
    phaseName: string,
    taskId: string,
  ): Promise<void> {
    // Entry phases (spec-writing) author the spec fresh, so the cached spec must
    // start blank: a re-entry — a human moving the ticket back to the writer,
    // often after emptying the spec field — must not hand last cycle's spec to
    // the writer as context (and must not let an emptied field hide behind a
    // stale cache). Clear here so every dispatch trigger is covered: webhook
    // phase-change / assignment-change, poller, reconciler, retry.
    if (this.deps.runtime.phaseGraph.getEntryPhases().some((p) => p.name === phaseName)) {
      const record = this.deps.pipelineState.get(issueId);
      if (record !== null && record.specContent !== null) {
        this.deps.pipelineState.clearSpec(issueId);
        this.deps.audit.log({
          component: "orchestrator",
          issueId,
          message: `Re-entry to entry phase ${phaseName} — cleared stale cached spec for a fresh write`,
          metadata: { taskId, phase: phaseName },
        });
      }
      return;
    }
    // Only re-read when the phase is downstream of a human gate (the gate's
    // `next` or `rework` target). Those are the moments humans can inline-edit
    // the spec on the tracker. Skipping mid-automation phases avoids a tracker
    // round-trip per dispatch.
    if (this.isPhaseAfterHumanGate(phaseName) === false) {
      return;
    }
    let fresh: string | null;
    try {
      fresh = await this.deps.issueTracker.getSpec(issueId);
    } catch (err) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Pre-dispatch spec re-read failed (${errorMessage(err)}) — keeping cached spec`,
        metadata: { taskId, phase: phaseName },
      });
      return;
    }
    const record = this.deps.pipelineState.get(issueId);
    if (record === null) {
      return;
    }
    if (fresh === null) {
      if (record.specContent !== null) {
        this.deps.audit.log({
          component: "orchestrator",
          issueId,
          message:
            "Tracker returned no spec but a cached spec exists — keeping cache. Check that the spec marker/field is intact on the tracker.",
          metadata: { taskId, phase: phaseName },
        });
      }
      return;
    }
    if (record.specContent === fresh) {
      return;
    }
    this.deps.pipelineState.updateSpec(issueId, fresh);
    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: `Pre-dispatch: refreshed cached spec from tracker (was ${String(record.specContent?.length ?? 0)} chars, now ${String(fresh.length)} chars)`,
      metadata: { taskId, phase: phaseName },
    });
  }

  private isPhaseAfterHumanGate(phaseName: string): boolean {
    // Precondition: the sole caller (syncSpecFromTracker) returns early for entry
    // phases, so phaseName here is always a non-entry phase. Without that guard
    // this would wrongly return true for spec-writing, since spec-awaiting-info is
    // a human gate whose `next` is spec-writing. A phase reachable from a gate's
    // `next`/`rework` is a spot a human may have inline-edited the spec on the
    // tracker, so we re-read it before dispatch — this keeps blocked → coding
    // covered (humans plausibly edit the spec there before unblocking).
    for (const gate of this.deps.runtime.phaseGraph.getHumanGates()) {
      if (gate.next === phaseName) {
        return true;
      }
      if (gate.rework === phaseName) {
        return true;
      }
    }
    return false;
  }

  // A spec-consuming phase (coding) must not run without a spec. The coder skill
  // self-checks too, but that's LLM-driven; this is the deterministic backstop for
  // a ticket moved straight to coding without ever being specced. Check the cache
  // first — it's what buildSkillContext hands the coder — then the tracker as the
  // source-of-truth fallback. On a tracker read error, proceed and let the coder's
  // own check catch it rather than block on a transient failure.
  private async guardRequiresSpec(
    task: Task,
    phase: PhaseDefinition,
  ): Promise<"proceed" | "kicked-back"> {
    const issueId = task.issueId;
    if (issueId === null) {
      return "proceed";
    }

    const cached = this.deps.pipelineState.get(issueId)?.specContent ?? null;
    if (cached !== null && cached.trim() !== "") {
      return "proceed";
    }

    let trackerSpec: string | null;
    try {
      trackerSpec = await this.deps.issueTracker.getSpec(issueId);
    } catch (err) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `requiresSpec guard: tracker spec read failed (${errorMessage(err)}) — proceeding, coder self-checks`,
        metadata: { taskId: task.id, phase: phase.name },
      });
      return "proceed";
    }
    if (trackerSpec !== null && trackerSpec.trim() !== "") {
      return "proceed";
    }

    const target = this.resolveSpecEntryPhase();
    this.deps.queue.markWorking(task.id);
    if (target === null) {
      this.deps.queue.markFailed(
        task.id,
        `${phase.name} requires a spec but none exists and no spec-producing entry phase is configured`,
      );
      this.deps.orchestratorState.incrementErrors();
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `${phase.name} requires a spec but none exists and no entry phase produces one — cannot kick back`,
        metadata: { taskId: task.id },
      });
      this.emitQueueChanged();
      return "kicked-back";
    }
    this.deps.queue.markComplete(task.id, `No spec — kicked ${phase.name} back to ${target}`);
    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: `${phase.name} dispatched with no spec — kicking back to ${target}, no worker launched`,
      metadata: { taskId: task.id, target },
    });
    await this.transitionTo(issueId, target, task);
    this.emitQueueChanged();
    return "kicked-back";
  }

  // Only a spec-producing entry phase can satisfy a kicked-back requiresSpec ticket.
  // Falling back to entries[0] when none produces a spec would re-dispatch coding into
  // the same empty-spec kickback every cycle, unbounded. Returning null instead routes
  // the caller to fail the task with a clear config error.
  private resolveSpecEntryPhase(): string | null {
    return (
      this.deps.runtime.phaseGraph.getEntryPhases().find((p) => p.producesSpec === true)?.name ??
      null
    );
  }

  private async dispatchWorkerForTask(
    task: Task,
    phase: PhaseDefinition,
    stack: StackResolution | null,
  ): Promise<void> {
    const issueId = task.issueId;
    if (issueId === null) {
      return;
    }
    // Per-dispatch resolution (not cached at start): phases hot-reload live, so a
    // reloaded config can introduce a codex phase between dispatches.
    const settings = resolveAgentSettings(this.deps.runtime.config.pipeline, phase);
    const bin = resolveAgentBin(settings.agent, this.deps.runtime.config.pipeline);
    if (bin === null) {
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markFailed(task.id, `${settings.agent} binary not found`);
      this.deps.orchestratorState.incrementErrors();
      return;
    }

    const skillName = phase.skill;
    if (skillName === undefined) {
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markFailed(task.id, `Phase ${phase.name} has no skill`);
      return;
    }

    const searchDirs = buildSkillSearchDirs({
      userSkillsDir: this.deps.runtime.config.skills.directory,
      projectRoot: this.deps.projectRoot,
      builtInSkillsDir: this.deps.builtInSkillsDir,
    });
    const skillPath = resolveSkillPath(
      searchDirs,
      skillName,
      this.deps.runtime.config.skills.disabled,
    );
    if (skillPath === null) {
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markFailed(task.id, `Skill not found: ${skillName}`);
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Skill file not found for ${skillName}`,
        metadata: { taskId: task.id, searchDirs },
      });
      return;
    }

    // pipelineState is the source of truth for delegator; task.metadata.delegator only
    // seeds it on first create. Updates to an existing record happen at webhook time.
    const delegatorFromTask =
      typeof task.metadata.delegator === "string" ? task.metadata.delegator : null;
    const pipelineRecord =
      this.deps.pipelineState.get(issueId) ??
      this.deps.pipelineState.create(issueId, phase.name, delegatorFromTask);

    let skillMarkdown: string;
    try {
      skillMarkdown = readFileSync(skillPath, "utf8");
    } catch (err) {
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markFailed(task.id, `Failed to read skill: ${errorMessage(err)}`);
      return;
    }

    let issueType: string | null = null;
    try {
      const issue = await this.deps.issueTracker.getIssue(issueId);
      issueType = issue.issueType;
    } catch (err) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Could not resolve issue type for branch prefix: ${errorMessage(err)}`,
        metadata: { taskId: task.id },
      });
    }

    const context = buildSkillContext({
      runtime: this.deps.runtime,
      task,
      pipelineRecord,
      phaseName: phase.name,
      issueType,
      resolveModule: this.moduleResolver,
      stack,
    });
    const promptBody = renderSkillPrompt(context, skillMarkdown);

    if (this.tempDir === null) {
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markFailed(task.id, "Orchestrator temp dir not initialized");
      return;
    }
    const tempPath = join(this.tempDir, `${task.id}.md`);
    try {
      // Recreate the temp dir before each write: a long-running daemon's dir can be
      // reaped by the OS tmp-cleaner or manual cleanup. mkdirSync(recursive) is idempotent.
      mkdirSync(this.tempDir, { recursive: true });
      writeFileSync(tempPath, promptBody, "utf8");
    } catch (err) {
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markFailed(
        task.id,
        `Failed to write skill prompt file: ${errorMessage(err)}`,
      );
      return;
    }

    const prompt = `Read and follow ${tempPath} exactly.`;

    // Best-effort Jira "In Progress" transition. Awaited so the status flips
    // before the worker spawns (ops visibility) — don't "optimize" to
    // fire-and-forget, that races the worker's "starting work" log output.
    // Adapter swallows its own errors; this outer catch is defense-in-depth.
    try {
      await this.deps.issueTracker.markInProgress(issueId);
    } catch (err) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `markInProgress failed (non-fatal): ${errorMessage(err)}`,
        metadata: { taskId: task.id, phase: phase.name },
      });
    }

    this.deps.orchestratorState.setStatus("working");
    this.deps.orchestratorState.setCurrentTaskId(task.id);
    this.emitDashboardStatus();
    this.emitWorkerStarted(task, phase);

    const startedAt = this.now();
    const abort = new AbortController();
    const stopPhaseWatch = this.startPhaseWatch(issueId, task, phase, abort);
    let result: WorkerResult;
    try {
      result = await this.runWorker({
        bin,
        agent: settings.agent,
        prompt,
        cwd: this.deps.runtime.config.project.directory,
        timeoutMs: this.deps.runtime.config.pipeline.workerTimeout * 1000,
        stallThresholdMs: this.deps.runtime.config.pipeline.stallThresholdMs,
        model: settings.model,
        effort: settings.effort,
        signal: abort.signal,
        onStart: (pid) => {
          this.currentWorkerPid = pid;
        },
        onHeartbeat: (info) => {
          this.deps.audit.log({
            component: "worker",
            issueId,
            message: `heartbeat pid=${String(info.pid)} elapsed=${String(info.elapsed)}s cpu=${info.cpuPercent}% rss=${info.rssKb}KB idle=${String(info.idleSeconds)}s`,
            metadata: { ...info, taskId: task.id },
          });
          this.dashboard?.emit({
            type: "worker:heartbeat",
            data: { taskId: task.id, ...info },
          });
        },
      });
    } finally {
      stopPhaseWatch();
      this.currentWorkerPid = null;
      safeUnlink(tempPath);
    }

    const elapsed = Math.round((this.now() - startedAt) / 1000);
    this.emitWorkerCompleted(task, phase, result, elapsed);

    // An abort means the ticket left this phase mid-run (the watch killed the
    // worker). That's not a failure — don't retry or route onFail. Gate on
    // result.success === false so a worker that cleanly exited 0 in the same
    // instant the abort fired still takes the success path.
    if (abort.signal.aborted && result.success === false) {
      await this.handleAbortedByPhaseChange(task, phase);
    } else if (result.success) {
      await this.handleSuccess(task, phase, result);
    } else {
      await this.handleFailure(task, phase, result);
    }

    if (this.webhook !== null) {
      try {
        await this.webhook.retryPendingMergeCleanup(issueId);
      } catch (err) {
        safeAudit(this.deps.audit, {
          component: "orchestrator",
          issueId,
          message: `Deferred merged-PR cleanup retry failed: ${errorMessage(err)}`,
          metadata: { taskId: task.id },
        });
      }
    }

    this.deps.orchestratorState.setStatus("idle");
    this.deps.orchestratorState.setCurrentTaskId(null);
    this.emitDashboardStatus();
    this.emitQueueChanged();
  }

  // While a worker runs, poll the tracker phase. If the ticket is moved out of the
  // phase the worker is executing, abort it — the work is now moot. Returns a stop
  // function the dispatch loop calls in its finally. Reentrancy-guarded so a slow
  // tracker read can't stack overlapping checks.
  private startPhaseWatch(
    issueId: string,
    task: Task,
    phase: PhaseDefinition,
    abort: AbortController,
  ): () => void {
    let checking = false;
    let driftSince: number | null = null;
    const intervalMs = this.deps.phaseWatchIntervalMs ?? PHASE_WATCH_INTERVAL_MS;
    const graceMs = this.deps.phaseDriftGraceMs ?? PHASE_DRIFT_GRACE_MS;
    const handle = setInterval(() => {
      if (checking || abort.signal.aborted) {
        return;
      }
      checking = true;
      void this.checkPhaseDrift(issueId, task, phase, abort, driftSince, graceMs)
        .then((next) => {
          driftSince = next;
        })
        .finally(() => {
          checking = false;
        });
    }, intervalMs);
    return () => {
      clearInterval(handle);
    };
  }

  // Decide whether a worker whose ticket left its phase should be aborted. A worker's
  // last act before exit is often a self-route via `set-phase` (coder → blocked /
  // spec-writing, tester → coding, reviewer → blocked, prompt-writer → awaiting-info);
  // for the few seconds it then takes to emit its final JSON and exit, the tracker
  // reads as drifted even though the worker is cleanly wrapping up. Aborting there
  // kills the process before that JSON lands, destroying the run's usage/cost/summary
  // and routing it through handleAbortedByPhaseChange instead of handleSuccess. So we
  // don't abort on first sight of drift: we start a grace clock and abort only once
  // the drift has outlasted it — by then a self-route has exited (this watch is torn
  // down in the dispatch finally and stops ticking), so a still-running drift means a
  // human moved the ticket and the worker is grinding on now-moot work. A forward
  // self-advance to `next` is never drift (handleSuccess owns it as selfAdvancedToNext).
  // Returns the next driftSince: null while on-phase, the first-seen timestamp once
  // drifted. A transient read error is swallowed and leaves the clock untouched.
  private async checkPhaseDrift(
    issueId: string,
    task: Task,
    phase: PhaseDefinition,
    abort: AbortController,
    driftSince: number | null,
    graceMs: number,
  ): Promise<number | null> {
    let current: string | null;
    try {
      current = await this.deps.issueTracker.getPhase(issueId);
    } catch {
      return driftSince;
    }
    if (current === null || current === phase.name || current === phase.next) {
      return null;
    }
    const now = this.now();
    if (driftSince === null) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Ticket moved to ${current} while ${phase.name} worker was running — holding ${String(Math.round(graceMs / 1000))}s in case the worker is self-routing before exit`,
        metadata: { taskId: task.id, runningPhase: phase.name, currentPhase: current },
      });
      return now;
    }
    if (now - driftSince < graceMs) {
      return driftSince;
    }
    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: `Ticket on ${current} for ${String(Math.round((now - driftSince) / 1000))}s while ${phase.name} worker still runs — aborting worker (human move, not a self-route)`,
      metadata: { taskId: task.id, runningPhase: phase.name, currentPhase: current },
    });
    abort.abort();
    return driftSince;
  }

  // The phase watch aborted the worker because the ticket left the running phase.
  // Not a failure: mark the task complete and respect wherever the ticket now sits
  // (respectAgentPhaseChange syncs local state and enqueues the new phase if needed,
  // idempotent via hasOpenTask). No retry, no onFail routing.
  private async handleAbortedByPhaseChange(task: Task, phase: PhaseDefinition): Promise<void> {
    const issueId = task.issueId;
    if (issueId === null) {
      return;
    }
    let newPhase: string | null;
    try {
      newPhase = await this.deps.issueTracker.getPhase(issueId);
    } catch {
      newPhase = null;
    }
    this.deps.queue.markComplete(
      task.id,
      `Aborted ${phase.name} — ticket moved to ${newPhase ?? "another phase"}`,
    );
    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: `Aborted ${phase.name} worker — ticket moved to ${newPhase ?? "unknown phase"}`,
      metadata: { taskId: task.id, newPhase },
    });
    if (newPhase !== null && newPhase !== phase.name) {
      this.respectAgentPhaseChange(issueId, task, newPhase);
    }
  }

  private async handleSuccess(
    task: Task,
    phase: PhaseDefinition,
    result: WorkerResult,
  ): Promise<void> {
    const issueId = task.issueId;
    if (issueId === null) {
      return;
    }

    // Read the tracker phase up front: it gates both the empty-spec check below
    // and the advance/respect decision at the end. A worker that routed itself
    // elsewhere (prompt-writer → spec-awaiting-info / blocked) surfaces here as a
    // phase that no longer matches the one we dispatched.
    let postPhase: string | null;
    try {
      postPhase = await this.deps.issueTracker.getPhase(issueId);
    } catch {
      postPhase = null;
    }
    const advancingNormally = postPhase === null || postPhase === phase.name;
    // A worker that self-routed forward to this phase's own `next` (the review
    // gate) is heading to the same place the orchestrator would advance it — so
    // the empty-spec check covers that disguise too, distinct from a deliberate
    // escape route (awaiting-info via onFail, or blocked).
    const selfAdvancedToNext = advancingNormally === false && postPhase === phase.next;

    // Empty-spec guard: a spec-producing phase that exits 0 but left the tracker
    // spec field empty has not actually succeeded — advancing (or letting the
    // worker's own forward jump stand) would park an empty prompt at the human
    // review gate (the "kicked back with no prompt" bug). A deliberate route to an
    // escape phase legitimately leaves the spec empty, so it's excluded. Read the
    // tracker, never the cache — the cache is the thing that may be stale.
    if (phase.producesSpec === true && (advancingNormally || selfAdvancedToNext)) {
      let trackerSpec: string | null = null;
      let specRead = true;
      try {
        trackerSpec = await this.deps.issueTracker.getSpec(issueId);
      } catch (err) {
        specRead = false;
        this.deps.audit.log({
          component: "orchestrator",
          issueId,
          message: `Post-${phase.name} spec read failed (${errorMessage(err)}) — skipping empty-spec guard`,
          metadata: { taskId: task.id },
        });
      }
      if (specRead && (trackerSpec === null || trackerSpec.trim() === "")) {
        // When the worker self-advanced to the gate, the retry path is a dead
        // end: preDispatchValidation kills any re-dispatch as stale once the
        // tracker sits on a human gate. Skip the retry and let handleFailure route
        // straight to onFail, overriding the bogus advance. The normal case (still
        // on this phase) keeps the retry → onFail → escalate ladder.
        this.deps.audit.log({
          component: "orchestrator",
          issueId,
          message: selfAdvancedToNext
            ? `${phase.name} self-advanced to ${phase.next} but wrote no spec — overriding to onFail instead of parking an empty prompt at the gate`
            : `${phase.name} exited 0 but the tracker spec is empty — routing through onFail instead of advancing to ${phase.next}`,
          metadata: { taskId: task.id },
        });
        await this.handleFailure(
          task,
          phase,
          { ...result, success: false, error: `${phase.name} produced an empty spec` },
          { skipRetry: selfAdvancedToNext },
        );
        return;
      }
    }

    await this.recordUsageAndPublish(issueId, phase, result);

    this.deps.queue.markComplete(task.id, result.summary);
    this.deps.orchestratorState.incrementCompleted();
    this.deps.pipelineState.updatePriorContext(issueId, result.summary);
    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: `${phase.name} completed in ${String(result.elapsed)}s`,
      metadata: { taskId: task.id, elapsed: result.elapsed },
    });

    // Alice parity: review_iterations measures pressure within a single
    // review loop. Once the reviewer phase passes, that loop is closed —
    // a downstream testing failure should re-enter the loop with a fresh
    // budget, not the count accumulated from this round. Leave
    // feedback_iterations alone: it tracks the orthogonal spec-rework loop.
    if (phase.resetReviewIterationsOnPass === true) {
      this.deps.pipelineState.resetReviewIterations(issueId);
    }

    if (phase.requiresPr === true) {
      const record = this.deps.pipelineState.get(issueId);
      const prNumber = record?.prNumber ?? null;
      if (prNumber !== null) {
        try {
          await this.deps.sourceControl.dismissStaleReviews(prNumber);
        } catch (err) {
          this.deps.audit.log({
            component: "orchestrator",
            issueId,
            message: `dismissStaleReviews failed after ${phase.name}: ${errorMessage(err)}`,
            metadata: { taskId: task.id, prNumber },
          });
        }
      }
    }

    if (postPhase !== null && postPhase !== phase.name) {
      this.respectAgentPhaseChange(issueId, task, postPhase);
      return;
    }

    await this.advanceNormal(issueId, phase, task);
  }

  private respectAgentPhaseChange(issueId: string, task: Task, newPhase: string): void {
    const phaseDef = this.deps.runtime.phaseGraph.getPhase(newPhase);
    this.deps.pipelineState.updatePhase(issueId, newPhase);
    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: `Agent changed phase to ${newPhase} — respecting agent decision`,
      metadata: { taskId: task.id, newPhase },
    });
    if (phaseDef === undefined) {
      return;
    }
    if (phaseDef.type === "human-gate") {
      const record = this.deps.pipelineState.get(issueId);
      // Fire-and-forget: the phase update above is already persisted and is
      // the user-visible primary signal; assignToHuman is a ping on top of
      // that. Unlike markInProgress (awaited because it races the worker's
      // own log output), this call has nothing to race — the skill has
      // already exited. Making respectAgentPhaseChange async would cascade
      // through handleSuccess for no behavioral win.
      void this.deps.issueTracker
        .assignToHuman(issueId, record?.delegatorAccountId ?? null)
        .catch((err: unknown) => {
          this.deps.audit.log({
            component: "orchestrator",
            issueId,
            message: `assignToHuman after agent phase change failed: ${errorMessage(err)}`,
            metadata: { taskId: task.id, newPhase },
          });
        });
      this.deps.queue.releaseDeferred();
      return;
    }
    if (this.deps.queue.hasOpenTask(issueId, newPhase) === false) {
      this.deps.queue.enqueue({
        type: newPhase,
        issueId,
        description: `Auto-created after agent set phase to ${newPhase}`,
      });
    }
  }

  private async advanceNormal(issueId: string, phase: PhaseDefinition, task: Task): Promise<void> {
    let nextPhaseName = phase.next;
    if (nextPhaseName === "done") {
      this.deps.pipelineState.markDone(issueId);
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Pipeline complete`,
        metadata: { taskId: task.id },
      });
      this.deps.queue.releaseDeferred();
      return;
    }

    let nextPhase = this.deps.runtime.phaseGraph.getPhase(nextPhaseName);
    if (nextPhase === undefined) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Next phase ${nextPhaseName} not found — stopping here`,
        metadata: { taskId: task.id, currentPhase: phase.name },
      });
      return;
    }

    // skipSpecReviewIfReady fast-path: when the just-completed phase recorded
    // zero open questions via `redqueen spec meta` and the global flag is on,
    // skip a human-gate next-hop and route straight to the gate's own next.
    // The count is treated as a single-use signal — cleared after consumption
    // so a stale value from a previous cycle can't fire it again.
    if (
      this.deps.runtime.config.pipeline.skipSpecReviewIfReady === true &&
      nextPhase.type === "human-gate"
    ) {
      const record = this.deps.pipelineState.get(issueId);
      if (record?.openQuestionCount === 0) {
        const skipTarget = nextPhase.next;
        this.deps.audit.log({
          component: "orchestrator",
          issueId,
          message: `Skipping human gate ${nextPhaseName} — 0 open questions and skipSpecReviewIfReady is on`,
          metadata: {
            taskId: task.id,
            fromPhase: phase.name,
            skippedGate: nextPhaseName,
            advancingTo: skipTarget,
          },
        });
        this.deps.pipelineState.setOpenQuestionCount(issueId, null);
        if (skipTarget === "done") {
          this.deps.pipelineState.markDone(issueId);
          this.deps.audit.log({
            component: "orchestrator",
            issueId,
            message: `Pipeline complete`,
            metadata: { taskId: task.id },
          });
          this.deps.queue.releaseDeferred();
          return;
        }
        const resolved = this.deps.runtime.phaseGraph.getPhase(skipTarget);
        if (resolved === undefined) {
          this.deps.audit.log({
            component: "orchestrator",
            issueId,
            message: `Skip target ${skipTarget} not found — stopping here`,
            metadata: { taskId: task.id, skippedGate: nextPhaseName },
          });
          return;
        }
        nextPhaseName = skipTarget;
        nextPhase = resolved;
      }
    }

    try {
      await this.deps.issueTracker.setPhase(issueId, nextPhaseName);
      if (nextPhase.type === "human-gate") {
        const record = this.deps.pipelineState.get(issueId);
        await this.deps.issueTracker.assignToHuman(issueId, record?.delegatorAccountId ?? null);
      } else {
        await this.deps.issueTracker.assignToAi(issueId);
      }
    } catch (err) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Failed to advance to ${nextPhaseName}: ${errorMessage(err)}`,
        metadata: { taskId: task.id },
      });
    }

    this.deps.pipelineState.updatePhase(issueId, nextPhaseName);

    if (nextPhase.type === "automated") {
      if (this.deps.queue.hasOpenTask(issueId, nextPhaseName) === false) {
        this.deps.queue.enqueue({
          type: nextPhaseName,
          issueId,
          description: `Auto-created after ${phase.name} completed`,
        });
      }
    } else {
      // Arrived at a human gate — a blocker may just have become satisfied.
      // Blind wake: the dequeue-time stack gate re-parks anything still blocked.
      this.deps.queue.releaseDeferred();
    }
  }

  // Cost tracking is observability — failures here must never gate phase
  // transitions. Any audit noise is surfaced via the audit log and then
  // swallowed so the pipeline keeps moving.
  private async recordUsageAndPublish(
    issueId: string,
    phase: PhaseDefinition,
    result: WorkerResult,
  ): Promise<void> {
    const costConfig = this.deps.runtime.config.pipeline.cost;
    if (costConfig.enabled === false) {
      return;
    }
    if (result.usage === null) {
      return;
    }
    // Cost keys must track the run that produced the tokens, so resolve the
    // same agent/model the dispatch used. A codex run without an explicit
    // model is keyed by agent name ("codex") — priceable via cost.pricing.
    const settings = resolveAgentSettings(this.deps.runtime.config.pipeline, phase);
    const model = settings.model ?? settings.agent;
    // Prefer Claude Code's own total_cost_usd (accurate across model mixes and
    // billing modes). Fall back to token×pricing only when the CLI reports no
    // cost — e.g. some Bedrock setups, where pipeline.cost.pricing carries the
    // enterprise rates.
    const reported = result.reportedCostUsd;
    const cost =
      reported !== null && reported > 0
        ? reported
        : computeCost(result.usage, model, costConfig.pricing);
    try {
      this.deps.phaseUsage.recordRun(issueId, phase.name, result.usage, cost);
    } catch (err) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `recordUsage failed for ${phase.name}: ${errorMessage(err)}`,
        metadata: { phase: phase.name },
      });
      return;
    }
    try {
      const breakdown = this.deps.phaseUsage.buildBreakdown(
        issueId,
        this.deps.runtime.phaseGraph,
        model,
      );
      await this.deps.issueTracker.setCostBreakdown(issueId, breakdown);
    } catch (err) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `setCostBreakdown failed for ${phase.name}: ${errorMessage(err)}`,
        metadata: { phase: phase.name },
      });
    }
  }

  private async handleFailure(
    task: Task,
    phase: PhaseDefinition,
    result: WorkerResult,
    opts: { skipRetry?: boolean } = {},
  ): Promise<void> {
    const issueId = task.issueId;
    if (issueId === null) {
      return;
    }
    await this.recordUsageAndPublish(issueId, phase, result);
    const error = result.error ?? "unknown error";
    this.deps.queue.markFailed(task.id, error);
    this.deps.orchestratorState.incrementErrors();
    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: `${phase.name} FAILED: ${error}`,
      metadata: { taskId: task.id, elapsed: result.elapsed, exitCode: result.exitCode },
    });

    const metadata = task.metadata;
    const priorRetries = typeof metadata.retries === "number" ? metadata.retries : 0;
    const nextRetries = priorRetries + 1;

    const retriesSkipped = phase.skipRetryOnFailure === true || opts.skipRetry === true;
    if (retriesSkipped === false && nextRetries <= this.deps.runtime.config.pipeline.maxRetries) {
      this.deps.queue.enqueue({
        type: task.type,
        issueId,
        description: `Retry ${String(nextRetries)} after: ${error}`,
        metadata: { ...metadata, retries: nextRetries },
      });
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Retrying ${phase.name} (attempt ${String(nextRetries + 1)}/${String(this.deps.runtime.config.pipeline.maxRetries + 1)})`,
        metadata: { taskId: task.id, retries: nextRetries },
      });
      return;
    }

    const onFail = phase.onFail;
    const escalateTo = phase.escalateTo;

    if (onFail !== undefined && onFail !== "done") {
      // reviewIterations measures automated-retry pressure within a single
      // review loop. When onFail points at a human-gate (e.g. spec-writing →
      // spec-awaiting-info), there's no automated retry happening — the
      // human is taking over — so don't bump the counter. The gate-leave
      // reset on the way back would zero it anyway, but skipping the
      // increment keeps the semantics clean and avoids confusing audit
      // entries.
      const onFailPhase = this.deps.runtime.phaseGraph.getPhase(onFail);
      const onFailIsAutomated = onFailPhase?.type === "automated";
      if (onFailIsAutomated) {
        const iter = this.deps.pipelineState.incrementReviewIterations(issueId);
        const maxIter = phase.maxIterations;
        if (
          maxIter !== undefined &&
          iter > maxIter &&
          escalateTo !== undefined &&
          escalateTo !== "done"
        ) {
          await this.failOver(issueId, phase, escalateTo, result, nextRetries, task);
          return;
        }
      }
      await this.failOver(issueId, phase, onFail, result, nextRetries, task);
      return;
    }

    if (escalateTo !== undefined && escalateTo !== "done") {
      await this.failOver(issueId, phase, escalateTo, result, nextRetries, task);
      return;
    }

    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: `${phase.name} gave up — no onFail or escalation configured`,
      metadata: { taskId: task.id },
    });
  }

  // Route a failed task to its next phase, first posting a human-readable notice
  // when that next phase is a human gate. We only comment on gate landings: a
  // failure that bounces back to an automated phase (e.g. code-review → coding)
  // is a normal feedback loop, and the reconciler re-enqueues automated phases
  // every poll — commenting there would spam the ticket on a stuck loop. A
  // human gate stops the pipeline, so the notice lands exactly once.
  private async failOver(
    issueId: string,
    fromPhase: PhaseDefinition,
    destination: string,
    result: WorkerResult,
    attempts: number,
    task: Task,
  ): Promise<void> {
    if (this.deps.runtime.phaseGraph.isHumanGate(destination)) {
      await this.postFailureNotice(issueId, fromPhase, destination, result, attempts, task);
    }
    await this.transitionTo(issueId, destination, task);
  }

  // Best-effort failure comment so a human looking at the ticket (not the logs)
  // can see why it stalled — especially auth/401 failures that silently park
  // every ticket at a gate. A comment failure is swallowed: it must never block
  // the transition (and if the worker died on auth, the tracker may be reachable
  // even when Claude isn't).
  private async postFailureNotice(
    issueId: string,
    fromPhase: PhaseDefinition,
    destination: string,
    result: WorkerResult,
    attempts: number,
    task: Task,
  ): Promise<void> {
    const destinationLabel =
      this.deps.runtime.phaseGraph.getPhase(destination)?.label ?? destination;
    const body = buildFailureNotice({
      phaseLabel: fromPhase.label,
      destinationLabel,
      attempts,
      result,
    });
    try {
      await this.deps.issueTracker.addComment(issueId, body);
    } catch (err) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Failed to post failure notice comment: ${errorMessage(err)}`,
        metadata: { taskId: task.id, phase: fromPhase.name, destination },
      });
    }
  }

  private async transitionTo(issueId: string, phaseName: string, task: Task): Promise<void> {
    const nextPhase = this.deps.runtime.phaseGraph.getPhase(phaseName);
    if (nextPhase === undefined) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Cannot transition to unknown phase ${phaseName}`,
        metadata: { taskId: task.id },
      });
      return;
    }
    try {
      await this.deps.issueTracker.setPhase(issueId, phaseName);
      if (nextPhase.type === "human-gate") {
        const record = this.deps.pipelineState.get(issueId);
        await this.deps.issueTracker.assignToHuman(issueId, record?.delegatorAccountId ?? null);
      } else {
        await this.deps.issueTracker.assignToAi(issueId);
      }
    } catch (err) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Transition to ${phaseName} failed: ${errorMessage(err)}`,
        metadata: { taskId: task.id },
      });
    }
    this.deps.pipelineState.updatePhase(issueId, phaseName);
    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: `Transitioned to ${phaseName}`,
      metadata: { taskId: task.id },
    });
    if (nextPhase.type === "automated") {
      if (this.deps.queue.hasOpenTask(issueId, phaseName) === false) {
        this.deps.queue.enqueue({
          type: phaseName,
          issueId,
          description: `Transitioned to ${phaseName}`,
        });
      }
    }
  }

  private performCrashRecovery(): void {
    const requeued = this.deps.queue.requeueAllWorking();
    for (const task of requeued) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId: task.issueId,
        message: `Crash recovery: re-queued task ${task.id}`,
        metadata: { taskId: task.id, type: task.type },
      });
    }
    this.deps.orchestratorState.setCurrentTaskId(null);
  }

  private removeTempDir(): void {
    if (this.tempDir === null) {
      return;
    }
    try {
      rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — ignore failures
    }
    this.tempDir = null;
  }

  private async startDashboardIfEnabled(): Promise<void> {
    const { dashboard: dashCfg, pipeline } = this.deps.runtime.config;
    const dashboardEnabled = dashCfg.enabled;
    const webhooksEnabled = pipeline.webhooks.enabled;
    if (dashboardEnabled === false && webhooksEnabled === false) {
      return;
    }
    const serviceDeps =
      this.deps.serviceManager !== undefined && this.deps.serviceContext !== undefined
        ? { manager: this.deps.serviceManager, context: this.deps.serviceContext }
        : undefined;
    const editorDeps =
      this.deps.configPath !== undefined &&
      this.deps.projectRoot !== undefined &&
      this.deps.builtInSkillsDir !== undefined
        ? {
            runtime: this.deps.runtime,
            configPath: this.deps.configPath,
            projectRoot: this.deps.projectRoot,
            builtInSkillsDir: this.deps.builtInSkillsDir,
            reload: (newConfig: RedQueenConfig) => this.reload(newConfig),
          }
        : undefined;
    // Cosmetic label only — a mixed-agent pipeline shows the master agent's model.
    const masterSettings = resolveAgentSettings(pipeline, {});
    const masterModel = masterSettings.model ?? masterSettings.agent;
    this.dashboard = new DashboardServer(
      {
        queue: this.deps.queue,
        orchestratorState: this.deps.orchestratorState,
        audit: this.deps.audit,
        service: serviceDeps,
        editor: editorDeps,
        cost: {
          phaseUsage: this.deps.phaseUsage,
          enabled: pipeline.cost.enabled,
          model: masterModel,
          buildBreakdown: (issueId: string) => {
            const live = resolveAgentSettings(this.deps.runtime.config.pipeline, {});
            return this.deps.phaseUsage.buildBreakdown(
              issueId,
              this.deps.runtime.phaseGraph,
              live.model ?? live.agent,
            );
          },
        },
      },
      {
        host: dashCfg.host,
        port: dashCfg.port,
        enableDashboardUi: dashboardEnabled,
        allowNonLoopback: dashCfg.allowNonLoopback,
        allowedHosts: dashCfg.allowedHosts,
        repoLabel: sourceControlRepoLabel(this.deps.runtime.config),
      },
    );
    await this.dashboard.start();
  }

  private setupWebhookServer(): void {
    // Constructed even with webhooks off or no dashboard to host the routes:
    // reconcileMergedPrs is the only reader of PR merge state, and a poll-only
    // deployment needs it most.
    this.webhook = new WebhookServer({
      issueTracker: this.deps.issueTracker,
      sourceControl: this.deps.sourceControl,
      queue: this.deps.queue,
      pipelineState: this.deps.pipelineState,
      runtime: this.deps.runtime,
      audit: this.deps.audit,
      onEvent: () => {
        this.emitQueueChanged();
      },
    });
    if (this.deps.runtime.config.pipeline.webhooks.enabled && this.dashboard !== null) {
      this.webhook.register(this.dashboard, this.deps.runtime.config.pipeline.webhooks.paths);
    }
  }

  private startPollerIfConfigured(): void {
    const intervalMs = this.deps.runtime.config.pipeline.reconcileInterval * 1000;
    if (intervalMs <= 0) {
      return;
    }
    this.poller = new Poller(
      {
        issueTracker: this.deps.issueTracker,
        queue: this.deps.queue,
        runtime: this.deps.runtime,
        pipelineState: this.deps.pipelineState,
        audit: this.deps.audit,
        onTick: () => {
          this.emitQueueChanged();
          const scan = this.webhook?.reconcileMergedPrs();
          if (scan !== undefined) {
            void scan.catch((err: unknown) => {
              safeAudit(this.deps.audit, {
                component: "orchestrator",
                issueId: null,
                message: `Merged-PR poll reconciliation failed: ${errorMessage(err)}`,
                metadata: {},
              });
            });
          }
        },
      },
      intervalMs,
    );
    this.poller.start();
  }

  private installSignalHandlers(): void {
    if (this.signalHandlersInstalled) {
      return;
    }
    this.signalHandlersInstalled = true;
    const handler = (): void => {
      void this.stop().catch((err: unknown) => {
        safeAudit(this.deps.audit, {
          component: "orchestrator",
          issueId: null,
          message: `Shutdown failed: ${errorMessage(err)}`,
          metadata: {},
        });
      });
    };
    this.sigHandler = handler;
    process.on("SIGTERM", handler);
    process.on("SIGINT", handler);
  }

  private uninstallSignalHandlers(): void {
    if (this.signalHandlersInstalled === false || this.sigHandler === null) {
      return;
    }
    process.off("SIGTERM", this.sigHandler);
    process.off("SIGINT", this.sigHandler);
    this.signalHandlersInstalled = false;
    this.sigHandler = null;
  }

  // Interval-gated audit-log prune, driven off the main loop (not any phase
  // transition, so the deterministic state machine stays untouched). Reads
  // retentionDays from runtime.config at call time, so a live reload is honored
  // on the next prune with no extra wiring.
  private maybePruneAudit(): void {
    const retentionDays = this.deps.runtime.config.audit.retentionDays;
    if (retentionDays <= 0) {
      return;
    }
    const now = this.now();
    if (now - this.lastAuditPruneMs < AUDIT_PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastAuditPruneMs = now;
    const removed = this.deps.audit.prune(retentionDays);
    if (removed > 0) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId: null,
        message: `Pruned ${String(removed)} audit entries older than ${String(retentionDays)} days`,
        metadata: { removed, retentionDays },
      });
    }
  }

  // Liveness floor for parked tasks: even with webhooks off and the poller
  // disabled, deferred tasks get re-evaluated on a throttled sweep. Blind
  // release is safe — the dequeue-time stack gate is the sole authority, and
  // wrongly-woken tasks just re-park.
  private maybeReleaseDeferred(): void {
    const reconcileInterval = this.deps.runtime.config.pipeline.reconcileInterval;
    const intervalMs = reconcileInterval > 0 ? reconcileInterval * 1000 : 300_000;
    const now = this.now();
    if (now - this.lastDeferredReleaseMs < intervalMs) {
      return;
    }
    this.lastDeferredReleaseMs = now;
    const released = this.deps.queue.releaseDeferred();
    if (released > 0) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId: null,
        message: `Deferred sweep released ${String(released)} parked task(s) for re-evaluation`,
        metadata: { released },
      });
      this.emitQueueChanged();
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  private emitDashboardStatus(): void {
    if (this.dashboard === null) {
      return;
    }
    const state = this.deps.orchestratorState.get();
    this.dashboard.emit({
      type: "orchestrator:status",
      data: {
        status: state.status,
        completedCount: state.completedCount,
        errorCount: state.errorCount,
      },
    });
  }

  private emitQueueChanged(): void {
    if (this.dashboard === null) {
      return;
    }
    const ready = this.deps.queue.listByStatus("ready");
    const working = this.deps.queue.listByStatus("working");
    this.dashboard.emit({
      type: "queue:changed",
      data: { readyCount: ready.length, workingCount: working.length },
    });
  }

  private emitWorkerStarted(task: Task, phase: PhaseDefinition): void {
    if (this.dashboard === null) {
      return;
    }
    this.dashboard.emit({
      type: "worker:started",
      data: {
        taskId: task.id,
        issueId: task.issueId,
        taskType: task.type,
        phaseLabel: phase.label,
        startedAt: new Date(this.now()).toISOString(),
      },
    });
  }

  private emitWorkerCompleted(
    task: Task,
    phase: PhaseDefinition,
    result: WorkerResult,
    elapsed: number,
  ): void {
    if (this.dashboard === null) {
      return;
    }
    this.dashboard.emit({
      type: "worker:completed",
      data: {
        taskId: task.id,
        issueId: task.issueId,
        taskType: task.type,
        phaseLabel: phase.label,
        elapsed,
        success: result.success,
        summary: result.summary,
      },
    });
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function killWorkerPid(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      process.kill(pid, signal);
    } catch {
      // Worker already exited
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Worker already exited
    }
  }
}

// Cosmetic header label. The adapter config shape is integration-specific, so
// read owner/repo generically off the untyped record rather than importing
// adapter types into core.
function sourceControlRepoLabel(config: RedQueenConfig): string | undefined {
  const sc = config.sourceControl.config;
  const owner = sc.owner;
  const repo = sc.repo;
  if (typeof owner === "string" && typeof repo === "string") {
    return `${owner}/${repo}`;
  }
  if (typeof repo === "string") {
    return repo;
  }
  return undefined;
}
