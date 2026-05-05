import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditLogger } from "./audit.js";
import { buildPhaseGraph } from "./config.js";
import type { RedQueenConfig } from "./config.js";
import type { OrchestratorStateStore, PipelineStateStore } from "./pipeline-state.js";
import { Poller } from "./poller.js";
import type { TaskQueue } from "./queue.js";
import { reconcile } from "./reconciler.js";
import { createModuleResolver } from "./module-resolver.js";
import type { RuntimeState } from "./runtime-state.js";
import type { ServiceInstallContext, ServiceManager } from "./service/index.js";
import { buildSkillContext, renderSkillPrompt, resolveSkillPath } from "./skill-context.js";
import type { ModuleResolver } from "./skill-context.js";
import type { PhaseDefinition, Task } from "./types.js";
import type { OrchestratorState } from "./types.js";
import { resolveClaudeBin, runWorker as defaultRunWorker } from "./worker.js";
import type { WorkerOptions, WorkerResult } from "./worker.js";
import type { IssueTracker } from "../integrations/issue-tracker.js";
import type { SourceControl } from "../integrations/source-control.js";
import { DashboardServer } from "../dashboard/server.js";
import { WebhookServer } from "../webhook/server.js";

export type WorkerRunner = (options: WorkerOptions) => Promise<WorkerResult>;

export interface ReloadResult {
  applied: string[];
  restartRequired: string[];
}

export interface RedQueenDeps {
  runtime: RuntimeState;
  queue: TaskQueue;
  pipelineState: PipelineStateStore;
  orchestratorState: OrchestratorStateStore;
  audit: AuditLogger;
  issueTracker: IssueTracker;
  sourceControl: SourceControl;
  workerRunner?: WorkerRunner;
  builtInSkillsDir?: string;
  moduleResolver?: ModuleResolver;
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  installSignalHandlers?: boolean;
  serviceManager?: ServiceManager;
  serviceContext?: ServiceInstallContext;
  configPath?: string;
  projectRoot?: string;
}

const TEMP_PREFIX = "rq-";

export class RedQueen {
  private readonly deps: RedQueenDeps;
  private readonly runWorker: WorkerRunner;
  private readonly moduleResolver: ModuleResolver;
  private readonly sleep: (ms: number) => Promise<void>;
  private dashboard: DashboardServer | null = null;
  private webhook: WebhookServer | null = null;
  private poller: Poller | null = null;
  private claudeBin: string | null = null;
  private shuttingDown = false;
  private shutdownCount = 0;
  private currentWorkerPid: number | null = null;
  private mainLoopPromise: Promise<void> | null = null;
  private signalHandlersInstalled = false;
  private sigHandler: ((sig: NodeJS.Signals) => void) | null = null;
  private tempDir: string | null = null;

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
    this.claudeBin = resolveClaudeBin(this.deps.runtime.config.pipeline.claudeBin);
    this.tempDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    this.performCrashRecovery();

    await this.startDashboardIfEnabled();
    this.startWebhookIfEnabled();

    try {
      await reconcile({
        issueTracker: this.deps.issueTracker,
        queue: this.deps.queue,
        runtime: this.deps.runtime,
        pipelineState: this.deps.pipelineState,
        audit: this.deps.audit,
      });
    } catch (err) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId: null,
        message: `Startup reconciliation failed: ${errorMessage(err)}`,
        metadata: {},
      });
    }

    this.startPollerIfConfigured();

    if (this.deps.installSignalHandlers === true) {
      this.installSignalHandlers();
    }

    const nowIso = new Date(this.now()).toISOString();
    this.deps.orchestratorState.setStatus("idle");
    this.deps.orchestratorState.setStartedAt(nowIso);
    this.emitDashboardStatus();

    this.mainLoopPromise = this.mainLoop();
    await this.mainLoopPromise;
  }

  async stop(): Promise<void> {
    this.shutdownCount++;
    this.shuttingDown = true;

    if (this.shutdownCount > 1 && this.currentWorkerPid !== null) {
      killWorkerPid(this.currentWorkerPid, "SIGTERM");
    }

    if (this.mainLoopPromise !== null) {
      try {
        await this.mainLoopPromise;
      } catch {
        // Errors handled inside main loop
      }
    }

    this.poller?.stop();
    if (this.webhook !== null) {
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

    if (task.type === "new-ticket") {
      await this.processNewTicketTask(task);
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

    const validation = await this.preDispatchValidation(task, phaseName);
    if (validation === "stale") {
      return;
    }

    await this.dispatchWorkerForTask(task, phase);
  }

  private async processNewTicketTask(task: Task): Promise<void> {
    const issueId = task.issueId;
    if (issueId === null) {
      return;
    }

    this.deps.queue.markWorking(task.id);
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
      await this.deps.issueTracker.assignToAi(issueId);
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

    const existingRecord = this.deps.pipelineState.get(issueId);
    if (existingRecord === null) {
      this.deps.pipelineState.create(issueId, firstPhase.name);
    } else {
      this.deps.pipelineState.updatePhase(issueId, firstPhase.name);
    }

    if (this.deps.queue.hasOpenTask(issueId, firstPhase.name) === false) {
      this.deps.queue.enqueue({
        type: firstPhase.name,
        issueId,
        priority: firstPhase.priority,
        description: `Initial ${firstPhase.label} task`,
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

  private async preDispatchValidation(task: Task, phaseName: string): Promise<"proceed" | "stale"> {
    const issueId = task.issueId;
    if (issueId === null) {
      return "proceed";
    }

    let currentPhase: string | null;
    try {
      currentPhase = await this.deps.issueTracker.getPhase(issueId);
    } catch (err) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Pre-dispatch phase read failed: ${errorMessage(err)}`,
        metadata: { taskId: task.id, phase: phaseName },
      });
      return "proceed";
    }

    if (currentPhase === phaseName) {
      return "proceed";
    }

    if (currentPhase !== null && this.deps.runtime.phaseGraph.isHumanGate(currentPhase)) {
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
      await this.deps.issueTracker.assignToAi(issueId);
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
    return "proceed";
  }

  private async dispatchWorkerForTask(task: Task, phase: PhaseDefinition): Promise<void> {
    const issueId = task.issueId;
    if (issueId === null) {
      return;
    }
    if (this.claudeBin === null) {
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markFailed(task.id, "Claude binary not found");
      this.deps.orchestratorState.incrementErrors();
      return;
    }

    const skillName = phase.skill;
    if (skillName === undefined) {
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markFailed(task.id, `Phase ${phase.name} has no skill`);
      return;
    }

    const skillPath = resolveSkillPath(
      this.deps.runtime.config.skills.directory,
      skillName,
      this.deps.runtime.config.skills.disabled,
      this.deps.builtInSkillsDir,
    );
    if (skillPath === null) {
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markFailed(task.id, `Skill not found: ${skillName}`);
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Skill file not found for ${skillName}`,
        metadata: { taskId: task.id, skillsDir: this.deps.runtime.config.skills.directory },
      });
      return;
    }

    const pipelineRecord =
      this.deps.pipelineState.get(issueId) ?? this.deps.pipelineState.create(issueId, phase.name);

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
    });
    const promptBody = renderSkillPrompt(context, skillMarkdown);

    if (this.tempDir === null) {
      this.deps.queue.markWorking(task.id);
      this.deps.queue.markFailed(task.id, "Orchestrator temp dir not initialized");
      return;
    }
    const tempPath = join(this.tempDir, `${task.id}.md`);
    try {
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

    this.deps.queue.markWorking(task.id);
    this.deps.orchestratorState.setStatus("working");
    this.deps.orchestratorState.setCurrentTaskId(task.id);
    this.emitDashboardStatus();
    this.emitWorkerStarted(task, phase);

    const startedAt = this.now();
    let result: WorkerResult;
    try {
      result = await this.runWorker({
        claudeBin: this.claudeBin,
        prompt,
        cwd: this.deps.runtime.config.project.directory,
        timeoutMs: this.deps.runtime.config.pipeline.workerTimeout * 1000,
        stallThresholdMs: this.deps.runtime.config.pipeline.stallThresholdMs,
        model: this.deps.runtime.config.pipeline.model,
        effort: this.deps.runtime.config.pipeline.effort,
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
      this.currentWorkerPid = null;
      safeUnlink(tempPath);
    }

    const elapsed = Math.round((this.now() - startedAt) / 1000);
    this.emitWorkerCompleted(task, phase, result, elapsed);

    if (result.success) {
      await this.handleSuccess(task, phase, result);
    } else {
      await this.handleFailure(task, phase, result);
    }

    this.deps.orchestratorState.setStatus("idle");
    this.deps.orchestratorState.setCurrentTaskId(null);
    this.emitDashboardStatus();
    this.emitQueueChanged();
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

    this.deps.queue.markComplete(task.id, result.summary);
    this.deps.orchestratorState.incrementCompleted();
    this.deps.pipelineState.updatePriorContext(issueId, result.summary);
    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: `${phase.name} completed in ${String(result.elapsed)}s`,
      metadata: { taskId: task.id, elapsed: result.elapsed },
    });

    let postPhase: string | null;
    try {
      postPhase = await this.deps.issueTracker.getPhase(issueId);
    } catch {
      postPhase = null;
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
    if (phaseDef === undefined || phaseDef.type === "human-gate") {
      return;
    }
    if (this.deps.queue.hasOpenTask(issueId, newPhase) === false) {
      this.deps.queue.enqueue({
        type: newPhase,
        issueId,
        priority: phaseDef.priority,
        description: `Auto-created after agent set phase to ${newPhase}`,
      });
    }
  }

  private async advanceNormal(issueId: string, phase: PhaseDefinition, task: Task): Promise<void> {
    const nextPhaseName = phase.next;
    if (nextPhaseName === "done") {
      this.deps.pipelineState.updatePhase(issueId, "done");
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Pipeline complete`,
        metadata: { taskId: task.id },
      });
      return;
    }

    const nextPhase = this.deps.runtime.phaseGraph.getPhase(nextPhaseName);
    if (nextPhase === undefined) {
      this.deps.audit.log({
        component: "orchestrator",
        issueId,
        message: `Next phase ${nextPhaseName} not found — stopping here`,
        metadata: { taskId: task.id, currentPhase: phase.name },
      });
      return;
    }

    try {
      await this.deps.issueTracker.setPhase(issueId, nextPhaseName);
      if (nextPhase.type === "human-gate") {
        await this.deps.issueTracker.assignToHuman(issueId);
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
          priority: nextPhase.priority,
          description: `Auto-created after ${phase.name} completed`,
        });
      }
    }
  }

  private async handleFailure(
    task: Task,
    phase: PhaseDefinition,
    result: WorkerResult,
  ): Promise<void> {
    const issueId = task.issueId;
    if (issueId === null) {
      return;
    }
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

    if (nextRetries <= this.deps.runtime.config.pipeline.maxRetries) {
      this.deps.queue.enqueue({
        type: task.type,
        issueId,
        priority: 0,
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
      const iter = this.deps.pipelineState.incrementReviewIterations(issueId);
      const maxIter = phase.maxIterations;
      if (
        maxIter !== undefined &&
        iter > maxIter &&
        escalateTo !== undefined &&
        escalateTo !== "done"
      ) {
        await this.transitionTo(issueId, escalateTo, task);
        return;
      }
      await this.transitionTo(issueId, onFail, task);
      return;
    }

    if (escalateTo !== undefined && escalateTo !== "done") {
      await this.transitionTo(issueId, escalateTo, task);
      return;
    }

    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: `${phase.name} gave up — no onFail or escalation configured`,
      metadata: { taskId: task.id },
    });
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
        await this.deps.issueTracker.assignToHuman(issueId);
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
          priority: nextPhase.priority,
          description: `Transitioned to ${phaseName}`,
        });
      }
    }
  }

  private performCrashRecovery(): void {
    const state = this.deps.orchestratorState.get();
    if (state.status !== "working" || state.currentTaskId === null) {
      return;
    }
    const task = this.deps.queue.getTask(state.currentTaskId);
    if (task === null) {
      this.deps.orchestratorState.setCurrentTaskId(null);
      return;
    }
    if (task.status !== "working") {
      this.deps.orchestratorState.setCurrentTaskId(null);
      return;
    }
    this.deps.queue.requeue(task.id);
    this.deps.orchestratorState.setCurrentTaskId(null);
    this.deps.audit.log({
      component: "orchestrator",
      issueId: task.issueId,
      message: `Crash recovery: re-queued task ${task.id}`,
      metadata: { taskId: task.id, type: task.type },
    });
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
    this.dashboard = new DashboardServer(
      {
        queue: this.deps.queue,
        orchestratorState: this.deps.orchestratorState,
        audit: this.deps.audit,
        service: serviceDeps,
        editor: editorDeps,
      },
      {
        host: dashCfg.host,
        port: dashCfg.port,
        enableDashboardUi: dashboardEnabled,
      },
    );
    await this.dashboard.start();
  }

  private startWebhookIfEnabled(): void {
    if (this.deps.runtime.config.pipeline.webhooks.enabled === false) {
      return;
    }
    if (this.dashboard === null) {
      return;
    }
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
    this.webhook.register(this.dashboard, this.deps.runtime.config.pipeline.webhooks.paths);
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
      void this.stop();
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

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
