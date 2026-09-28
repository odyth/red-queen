import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import type { IncomingMessage, ServerResponse } from "node:http";
import { routeAiAssignment } from "../core/assignment-router.js";
import { safeAudit } from "../core/audit.js";
import type { AuditLogger } from "../core/audit.js";
import { withTimeout } from "../core/async.js";
import { errorMessage } from "../core/errors.js";
import type { TaskQueue } from "../core/queue.js";
import {
  classifyMergeTransition,
  classifyRepoMergeTransition,
  primaryRepoName,
} from "../core/pipeline-state.js";
import type { PipelineStateStore } from "../core/pipeline-state.js";
import { autoTransitionRework } from "../core/rework-transition.js";
import type { RuntimeState } from "../core/runtime-state.js";
import { gitCwdFor, worktreePathFor } from "../core/worktree-layout.js";
import type { PipelineEvent, PipelineRecord, PipelineRepoRecord } from "../core/types.js";
import type { IssueTracker } from "../integrations/issue-tracker.js";
import type { PullRequest } from "../integrations/source-control.js";
import type { SourceControlRegistry } from "../integrations/source-control-registry.js";
import type { DashboardServer, RouteHandler } from "../dashboard/server.js";

export type GitRunner = (args: string[], cwd: string) => Promise<void>;

export interface WebhookServerDeps {
  issueTracker: IssueTracker;
  sourceControls: SourceControlRegistry;
  queue: TaskQueue;
  pipelineState: PipelineStateStore;
  runtime: RuntimeState;
  audit: AuditLogger;
  onEvent?: (event: PipelineEvent) => void;
  gitRunner?: GitRunner;
}

export interface WebhookRoutePaths {
  issueTracker: string;
  sourceControl: string;
}

const DEFAULT_ROUTE_PATHS: WebhookRoutePaths = {
  issueTracker: "/webhook/issue-tracker",
  sourceControl: "/webhook/source-control",
};

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REMOTE_LOOKUP_TIMEOUT_MS = 30_000;
const REMOTE_MUTATION_TIMEOUT_MS = 60_000;
const GIT_OPERATION_TIMEOUT_MS = 120_000;
const MERGE_LOOKUP_CONCURRENCY = 5;

interface MergedPrCandidate {
  record: PipelineRecord;
  row: PipelineRepoRecord;
  pr: PullRequest;
}

function pendingKey(issueId: string, repo: string): string {
  return `${issueId}\u0000${repo}`;
}

interface PendingMergeCleanup {
  event: PipelineEvent;
  repo: string;
  expectedPrNumber: number | null;
}

export class WebhookServer {
  private readonly deps: WebhookServerDeps;
  private readonly gitRunner: GitRunner;
  // Serializes retarget+refresh scans across concurrent webhook deliveries:
  // cascading stack merges or duplicate deliveries would otherwise race on
  // the same refresh worktree and double-push dependents.
  // ponytail: global chain — per-issue locks if merge volume ever matters.
  private refreshChain: Promise<void> = Promise.resolve();
  private mergeScanPromise: Promise<void> | null = null;
  private readonly pendingMergeCleanup = new Map<string, PendingMergeCleanup>();
  // Feedback mutates the tracker before committing locally. Serialize events
  // for one resolved issue so a merge records the final feedback phase as its
  // prior phase, which lets reconciliation distinguish replay from re-entry.
  private readonly eventChains = new Map<string, Promise<void>>();

  constructor(deps: WebhookServerDeps) {
    this.deps = deps;
    this.gitRunner = deps.gitRunner ?? defaultGitRunner;
  }

  register(dashboard: DashboardServer, paths: WebhookRoutePaths = DEFAULT_ROUTE_PATHS): void {
    dashboard.registerRoute(
      "POST",
      paths.issueTracker,
      this.handleIssueTracker.bind(this) as RouteHandler,
    );
    dashboard.registerRoute(
      "POST",
      paths.sourceControl,
      this.handleSourceControl.bind(this) as RouteHandler,
    );
  }

  private async handleIssueTracker(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.handleAdapter(req, res, "issue-tracker", {
      validate: (headers, body) => this.deps.issueTracker.validateWebhook(headers, body),
      parse: (headers, body) => this.deps.issueTracker.parseWebhookEvent(headers, body),
    });
  }

  private async handleSourceControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.handleAdapter(req, res, "source-control", {
      validate: (headers, body) => this.deps.sourceControls.any().validateWebhook(headers, body),
      parse: (headers, body) => this.deps.sourceControls.any().parseWebhookEvent(headers, body),
    });
  }

  private async handleAdapter(
    req: IncomingMessage,
    res: ServerResponse,
    component: string,
    handlers: {
      validate: (headers: Record<string, string>, body: string) => boolean;
      parse: (headers: Record<string, string>, body: string) => PipelineEvent | null;
    },
  ): Promise<void> {
    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      this.deps.audit.log({
        component,
        issueId: null,
        message: `Webhook body read failed: ${errorMessage(err)}`,
        metadata: {},
      });
      res.writeHead(413, { "Content-Type": "text/plain" });
      res.end("Payload Too Large");
      return;
    }

    const headers = normalizeHeaders(req.headers);

    if (handlers.validate(headers, body) === false) {
      this.deps.audit.log({
        component,
        issueId: null,
        message: "Webhook rejected: invalid signature",
        metadata: {},
      });
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    let event: PipelineEvent | null;
    try {
      event = handlers.parse(headers, body);
    } catch (err) {
      this.deps.audit.log({
        component,
        issueId: null,
        message: `Webhook parse failed: ${errorMessage(err)}`,
        metadata: {},
      });
      return;
    }

    if (event === null) {
      return;
    }

    try {
      await this.dispatchEvent(event, component);
    } catch (err) {
      this.deps.audit.log({
        component,
        issueId: event.issueId,
        message: `Webhook dispatch failed: ${errorMessage(err)}`,
        metadata: { eventType: event.type },
      });
    }
  }

  private async dispatchEvent(event: PipelineEvent, component: string): Promise<void> {
    // PR issue_comment may initially identify #PR rather than its tracker
    // ticket. Choose the serialization key only after resolving that identity.
    if (event.type === "pr-feedback") {
      const routed = this.resolveFeedbackEvent(event, component);
      if (routed === null) {
        return;
      }
      event = routed;
    }
    const previous = this.eventChains.get(event.issueId) ?? Promise.resolve();
    const run = previous.then(() => this.applyEvent(event, component));
    const tracked = run
      .catch(() => undefined)
      .finally(() => {
        if (this.eventChains.get(event.issueId) === tracked) {
          this.eventChains.delete(event.issueId);
        }
      });
    this.eventChains.set(event.issueId, tracked);
    await run;
  }

  private async applyEvent(event: PipelineEvent, component: string): Promise<void> {
    const { issueTracker, queue, runtime, pipelineState, audit } = this.deps;

    if (
      (event.type === "phase-change" || event.type === "assignment-change") &&
      extractString(event.payload, "repo") !== null &&
      this.isTrackerEventRepo(event, component) === false
    ) {
      return;
    }

    if (event.type === "pr-feedback") {
      const routed = this.resolveFeedbackEvent(event, component);
      if (routed === null) {
        return;
      }
      event = routed;
    }

    switch (event.type) {
      case "phase-change": {
        const phaseName = extractString(event.payload, "phase");
        if (phaseName === null) {
          return;
        }
        const delegator = extractString(event.payload, "delegator");
        if (runtime.phaseGraph.isHumanGate(phaseName)) {
          audit.log({
            component,
            issueId: event.issueId,
            message: `phase-change to human gate ${phaseName} — no task created`,
            metadata: { phase: phaseName },
          });
          // Gate arrival may satisfy a stack blocker — blind-wake parked tasks;
          // the orchestrator's dequeue gate re-parks anything still blocked.
          queue.releaseDeferred();
          break;
        }
        const phase = runtime.phaseGraph.getPhase(phaseName);
        if (phase === undefined) {
          audit.log({
            component,
            issueId: event.issueId,
            message: `phase-change references unknown phase ${phaseName}`,
            metadata: { phase: phaseName },
          });
          return;
        }
        const entryPhaseNames = new Set(runtime.phaseGraph.getEntryPhases().map((p) => p.name));
        if (entryPhaseNames.has(phaseName) === false) {
          const record = pipelineState.get(event.issueId);
          if (record === null) {
            audit.log({
              component,
              issueId: event.issueId,
              message: "no local pipeline state — run new-ticket first",
              metadata: { phase: phaseName },
            });
            break;
          }
          if (delegator !== null) {
            pipelineState.updateDelegator(event.issueId, delegator);
          }
        } else if (delegator !== null) {
          // Entry phase: the new-ticket task created below carries delegator in metadata
          // and persists it on create. If a record already exists (re-entry), keep it in sync.
          const record = pipelineState.get(event.issueId);
          if (record !== null) {
            pipelineState.updateDelegator(event.issueId, delegator);
          }
        }
        if (queue.hasOpenTask(event.issueId, phaseName)) {
          break;
        }
        queue.enqueue({
          type: phaseName,
          issueId: event.issueId,
          description: `Phase change from webhook`,
          metadata: delegator !== null ? { delegator } : undefined,
        });
        break;
      }
      case "pr-feedback": {
        const record = pipelineState.get(event.issueId);
        const hasPr = record?.repos.some((row) => row.inScope && row.prNumber !== null) ?? false;
        // Find the rework phase whose requiresPr matches current PR state.
        // Restrict to "-feedback" phases so we don't accidentally pick an
        // automated review phase that also declares requiresPr.
        // Looking up by metadata + name suffix (not hardcoded
        // "code-feedback"/"spec-feedback") lets customized phase graphs
        // route correctly as long as they follow the naming convention.
        const reworkPhase = runtime.phaseGraph
          .getAllPhases()
          .find((p) => p.requiresPr === hasPr && p.name.endsWith("-feedback"));
        if (reworkPhase === undefined) {
          audit.log({
            component,
            issueId: event.issueId,
            message: `pr-feedback: no phase with requiresPr=${String(hasPr)} in graph — dropping event`,
            metadata: { hasPr },
          });
          break;
        }
        const taskType = reworkPhase.name;
        // Hand the ticket back to the AI the instant feedback lands so the
        // human's review queue stops listing it as theirs — don't wait for the
        // orchestrator to dequeue (it may be deep in a backlog). Deterministic +
        // idempotent: autoTransitionRework only mutates when the tracker is
        // parked at a human gate whose rework target is this phase, so it can't
        // race the orchestrator while it's actively working the ticket. The
        // orchestrator's preDispatchValidation re-runs the same transition as a
        // fallback (e.g. if the read below fails).
        let currentPhase: string | null = null;
        try {
          currentPhase = await issueTracker.getPhase(event.issueId);
        } catch (err) {
          audit.log({
            component,
            issueId: event.issueId,
            message: `pr-feedback: phase read failed, deferring transition to dispatch: ${errorMessage(err)}`,
            metadata: { taskType },
          });
        }
        // The remote phase read may outlive a PR replacement, merge or scope
        // change. Recheck before handing the ticket back to automation.
        if (this.resolveFeedbackEvent(event, component) === null) {
          break;
        }
        if (currentPhase !== null) {
          await autoTransitionRework(
            {
              issueTracker,
              pipelineState,
              phaseGraph: runtime.phaseGraph,
              audit,
              isCurrent: () => this.resolveFeedbackEvent(event, component) !== null,
            },
            event.issueId,
            currentPhase,
            taskType,
            component,
            { source: "pr-feedback" },
          );
        }
        if (
          this.resolveFeedbackEvent(event, component) === null ||
          queue.hasOpenTask(event.issueId, taskType)
        ) {
          break;
        }
        queue.enqueue({
          type: taskType,
          issueId: event.issueId,
          description: "PR feedback",
        });
        audit.log({
          component,
          issueId: event.issueId,
          message: `pr-feedback enqueued ${taskType}`,
          metadata: { taskType, hasPr },
        });
        break;
      }
      case "pr-merged": {
        const record = pipelineState.get(event.issueId);
        const mergedPrNumber = extractNumber(event.payload, "prNumber");
        if (record === null) {
          audit.log({
            component,
            issueId: event.issueId,
            message: "PR merged — no pipeline record, skipping local cleanup",
            metadata: {},
          });
          break;
        }
        const repoName = this.resolveEventRepo(event, record, component);
        if (repoName === null) {
          break;
        }
        let row = record.repos.find((r) => r.repo === repoName) ?? null;
        // Legacy deliveries may predate all local PR data. Workspaces must
        // declare scope explicitly, including a workspace with just one repo.
        if (
          row === null &&
          record.repos.length === 0 &&
          runtime.config.project.workspaceMode === false &&
          classifyMergeTransition(record, mergedPrNumber) === "process"
        ) {
          pipelineState.setScope(event.issueId, [repoName]);
          row = pipelineState.getRepo(event.issueId, repoName);
        }
        if (row === null) {
          audit.log({
            component,
            issueId: event.issueId,
            message: `PR merged in ${repoName}, but the issue has no row for that repo — ignoring`,
            metadata: { repo: repoName, mergedPrNumber },
          });
          break;
        }
        const mergedBranch = extractString(event.payload, "branch") ?? row.branchName;
        const mergedBase = extractString(event.payload, "base") ?? row.prBaseBranch;
        const disposition = classifyMergedPrEvent(
          record.currentPhase,
          row,
          mergedPrNumber,
          mergedBranch,
        );
        if (disposition !== "process") {
          audit.log({
            component,
            issueId: event.issueId,
            message:
              disposition === "already-processed"
                ? `PR #${String(mergedPrNumber)} (${repoName}) merge cleanup was already processed — ignoring duplicate delivery`
                : `PR #${String(mergedPrNumber)} (${repoName}) merged, but it belongs to an earlier pipeline run — ignoring stale cleanup`,
            metadata: {
              repo: repoName,
              mergedPrNumber,
              currentPrNumber: row.prNumber,
              terminalPrNumber: row.terminalPrNumber,
              mergedBranch,
              currentBranch: row.branchName,
            },
          });
          break;
        }
        const working = queue
          .listByStatus("working")
          .some((task) => task.issueId === event.issueId);
        if (working) {
          const expectedPrNumber = mergedPrNumber ?? row.prNumber;
          this.pendingMergeCleanup.set(pendingKey(event.issueId, repoName), {
            repo: repoName,
            expectedPrNumber,
            event: {
              ...event,
              payload: {
                ...event.payload,
                repoName,
                ...(expectedPrNumber === null ? {} : { prNumber: expectedPrNumber }),
                ...(mergedBranch === null ? {} : { branch: mergedBranch }),
                ...(mergedBase === null ? {} : { base: mergedBase }),
              },
            },
          });
          audit.log({
            component,
            issueId: event.issueId,
            message: `PR merged (${repoName}) — cleanup deferred because the issue has a working task`,
            metadata: {
              repo: repoName,
              prNumber: row.prNumber,
              worktreePath: row.worktreePath,
              branchName: row.branchName,
            },
          });
          break;
        }

        const transition = pipelineState.markPrMerged(event.issueId, repoName, mergedPrNumber);
        this.pendingMergeCleanup.delete(pendingKey(event.issueId, repoName));
        if (transition !== "processed" && transition !== "pending-others") {
          audit.log({
            component,
            issueId: event.issueId,
            message: `PR merge cleanup skipped after state recheck: ${transition}`,
            metadata: { repo: repoName, mergedPrNumber },
          });
          break;
        }
        const cancelledTasks =
          transition === "processed"
            ? queue.cancelPendingForIssue(event.issueId, "Cancelled — pull request merged")
            : 0;

        await this.cleanupLocalBranchArtifacts(
          event.issueId,
          repoName,
          row.worktreePath,
          row.branchName,
          component,
          "pr-merged cleanup",
        );
        const remaining = pipelineState
          .listRepos(event.issueId)
          .filter((r) => r.inScope && r.mergeCompleted === false).length;
        const cleanedRow = pipelineState.getRepo(event.issueId, repoName);
        const cleanupPending =
          cleanedRow !== null &&
          (cleanedRow.branchName !== null || cleanedRow.worktreePath !== null);
        audit.log({
          component,
          issueId: event.issueId,
          message:
            transition === "processed"
              ? `PR merged (${repoName}) — every in-scope PR merged; local cleanup ${cleanupPending ? "pending" : "complete"}`
              : `PR merged (${repoName}) — ${String(remaining)} in-scope repo(s) still awaiting merge; local cleanup ${cleanupPending ? "pending" : "complete"}`,
          metadata: {
            repo: repoName,
            hadWorktree: row.worktreePath !== null,
            hadBranch: row.branchName !== null,
            cancelledTasks,
            inScope: row.inScope,
            remainingRepos: remaining,
            cleanupPending,
          },
        });

        // Stacked dependents in the same repo: retarget their PRs off the merged
        // branch and deterministically fold the merged base into their branches.
        if (
          mergedBranch !== null &&
          mergedBase !== null &&
          cleanedRow?.mergeCompleted === true &&
          cleanedRow.prNumber === null &&
          cleanedRow.terminalPrNumber === (mergedPrNumber ?? row.prNumber)
        ) {
          const run = this.refreshChain.then(() =>
            this.retargetAndRefreshDependents(
              event.issueId,
              repoName,
              mergedBranch,
              mergedBase,
              component,
            ),
          );
          this.refreshChain = run.catch(() => undefined);
          await run;
        }

        if (transition === "processed") {
          queue.releaseDeferred();
        }
        break;
      }
      case "assignment-change": {
        const delegator = extractString(event.payload, "delegator");
        await routeAiAssignment(
          { issueTracker, queue, runtime, pipelineState, audit },
          {
            issueId: event.issueId,
            component,
            description: "Assigned to AI",
            delegator,
          },
        );
        break;
      }
      case "new-ticket": {
        if (queue.hasOpenTask(event.issueId, "new-ticket")) {
          break;
        }
        queue.enqueue({
          type: "new-ticket",
          issueId: event.issueId,
          description: "New ticket",
        });
        break;
      }
    }

    if (this.deps.onEvent) {
      this.deps.onEvent(event);
    }
  }

  // A pr-merged event that never arrives (event not subscribed, delivery
  // failed, crash between the 200 and dispatch) strands the issue mid-pipeline
  // with a live worktree and leaves its stacked dependents unrefreshed forever
  // — nothing else in the system reads PR merge state. Replay it from the
  // source of truth on startup and every poll tick.
  async reconcileMergedPrs(): Promise<void> {
    if (this.mergeScanPromise !== null) {
      return this.mergeScanPromise;
    }
    const tracked = this.runMergedPrScan().finally(() => {
      if (this.mergeScanPromise === tracked) {
        this.mergeScanPromise = null;
      }
    });
    this.mergeScanPromise = tracked;
    return tracked;
  }

  async retryPendingMergeCleanup(issueId: string): Promise<void> {
    for (const [key, pending] of [...this.pendingMergeCleanup.entries()]) {
      if (pending.event.issueId !== issueId) {
        continue;
      }
      const record = this.deps.pipelineState.get(issueId);
      const row = record?.repos.find((r) => r.repo === pending.repo) ?? null;
      const prChanged =
        row !== null &&
        (pending.expectedPrNumber === null
          ? row.prNumber !== null
          : row.prNumber !== null && row.prNumber !== pending.expectedPrNumber);
      if (record === null || row === null || prChanged) {
        this.pendingMergeCleanup.delete(key);
        safeAudit(this.deps.audit, {
          component: "webhook-reconcile",
          issueId,
          message: "Deferred merged-PR cleanup discarded because the row now has a different PR",
          metadata: {
            repo: pending.repo,
            expectedPrNumber: pending.expectedPrNumber,
            currentPrNumber: row?.prNumber ?? null,
          },
        });
        continue;
      }
      // Consume this exact deferred event before replay. Dispatch reinserts it
      // if a worker still owns the issue; stale/duplicate events stay retired.
      this.pendingMergeCleanup.delete(key);
      await this.dispatchEvent(pending.event, "webhook-reconcile");
    }
    // The worker that just finished may have shrunk the issue's scope.
    this.completeIfMerged(issueId, "webhook-reconcile");
  }

  // A scope change can leave nothing to wait for without a merge event to say
  // so. Held back under a working task like merge cleanup is: the worker's
  // phase advance would reopen the issue.
  private completeIfMerged(issueId: string, component: string): void {
    if (
      this.hasWorkingTask(issueId) ||
      this.deps.pipelineState.completeIfMerged(issueId) === false
    ) {
      return;
    }
    const cancelledTasks = this.deps.queue.cancelPendingForIssue(
      issueId,
      "Cancelled — every in-scope pull request merged",
    );
    safeAudit(this.deps.audit, {
      component,
      issueId,
      message: "Issue complete — every in-scope PR had already merged when its scope changed",
      metadata: { cancelledTasks },
    });
    this.deps.queue.releaseDeferred();
  }

  async drain(): Promise<void> {
    do {
      await Promise.all([
        ...this.eventChains.values(),
        this.refreshChain,
        ...(this.mergeScanPromise === null ? [] : [this.mergeScanPromise]),
      ]);
    } while (this.eventChains.size > 0 || this.mergeScanPromise !== null);
  }

  private hasWorkingTask(issueId: string): boolean {
    return this.deps.queue.listByStatus("working").some((task) => task.issueId === issueId);
  }

  private resolveEventRepo(
    event: PipelineEvent,
    record: PipelineRecord | null,
    component: string,
  ): string | null {
    const named = extractString(event.payload, "repoName");
    const fullName = extractString(event.payload, "repo");
    const { sourceControls, pipelineState, audit } = this.deps;
    if (fullName !== null) {
      const entry = sourceControls.byFullName(fullName);
      if (entry === null || (named !== null && named !== entry.name)) {
        audit.log({
          component,
          issueId: event.issueId,
          message: `${event.type} for unknown repo ${fullName} or mismatched repo name — dropped (configured: ${sourceControls.names().join(", ")})`,
          metadata: { repo: fullName, repoName: named },
        });
        return null;
      }
      return entry.name;
    }
    if (named !== null) {
      if (sourceControls.names().includes(named) === false) {
        audit.log({
          component,
          issueId: event.issueId,
          message: `${event.type} for unknown repo ${named} — dropped (configured: ${sourceControls.names().join(", ")})`,
          metadata: { repoName: named },
        });
        return null;
      }
      return named;
    }
    // Legacy adapters and mock events may omit repository identity. Selecting
    // the primary row never creates scope in a workspace.
    return record === null
      ? pipelineState.defaultRepo
      : primaryRepoName(record, pipelineState.defaultRepo);
  }

  private resolveFeedbackEvent(event: PipelineEvent, component: string): PipelineEvent | null {
    const { pipelineState, audit } = this.deps;
    const target = extractString(event.payload, "feedbackTarget");
    if (target === "issue") {
      // GitHub issue_comment covers both issues and PRs. Ordinary tracker
      // comments use tracker issue numbers, never a source-control PR lookup.
      return this.isTrackerEventRepo(event, component) ? event : null;
    }
    const number = extractNumber(event.payload, "prNumber");
    const branch = extractString(event.payload, "branch");
    const isPrFeedback =
      target === "pull-request" ||
      number !== null ||
      branch !== null ||
      extractString(event.payload, "repo") !== null ||
      extractString(event.payload, "repoName") !== null;
    // Existing tracker adapters emit issue-level feedback without PR fields.
    if (isPrFeedback === false) {
      return event;
    }
    const originalRecord = pipelineState.get(event.issueId);
    const repoName = this.resolveEventRepo(event, originalRecord, component);
    if (repoName === null) {
      return null;
    }
    const record = number === null ? originalRecord : pipelineState.findByPr(repoName, number);
    const row = record?.repos.find((entry) => entry.repo === repoName) ?? null;
    if (
      record === null ||
      record.currentPhase === "done" ||
      row === null ||
      row.inScope === false ||
      row.mergeCompleted ||
      row.prNumber === null ||
      row.prNumber === row.terminalPrNumber ||
      (branch !== null && row.branchName !== null && branch !== row.branchName)
    ) {
      audit.log({
        component,
        issueId: record?.issueId ?? event.issueId,
        message: `PR feedback for ${repoName}#${String(number)} is not an in-scope current PR — dropped`,
        metadata: { repo: repoName, prNumber: number, branch },
      });
      return null;
    }
    return {
      ...event,
      issueId: record.issueId,
      payload: { ...event.payload, repoName, prNumber: row.prNumber },
    };
  }

  private isTrackerEventRepo(event: PipelineEvent, component: string): boolean {
    const tracker = this.deps.runtime.config.issueTracker;
    const owner = extractString(tracker.config, "owner");
    const repo = extractString(tracker.config, "repo");
    const fullName = extractString(event.payload, "repo");
    if (
      tracker.type === "github-issues" &&
      owner !== null &&
      repo !== null &&
      fullName?.toLowerCase() === `${owner}/${repo}`.toLowerCase()
    ) {
      return true;
    }
    this.deps.audit.log({
      component,
      issueId: event.issueId,
      message: `${event.type} outside the configured tracker repository — dropped`,
      metadata: { repo: fullName },
    });
    return false;
  }

  // Remote lookups and mutations can outlive a scope/PR replacement. Only
  // continue the dependent operation while the snapshot still names its row.
  private currentDependentRow(expected: PipelineRepoRecord): PipelineRepoRecord | null {
    const record = this.deps.pipelineState.get(expected.issueId);
    const row = record?.repos.find((entry) => entry.repo === expected.repo);
    if (
      record === null ||
      record.currentPhase === "done" ||
      row === undefined ||
      row.inScope === false ||
      row.mergeCompleted ||
      row.prNumber === null ||
      row.prNumber === row.terminalPrNumber ||
      row.prNumber !== expected.prNumber ||
      row.branchName !== expected.branchName ||
      row.prBaseBranch !== expected.prBaseBranch
    ) {
      return null;
    }
    return row;
  }

  private async runMergedPrScan(): Promise<void> {
    const component = "webhook-reconcile";
    const { pipelineState } = this.deps;
    const all = pipelineState.listAll();

    // Completion is per row: a crash after a partial merge leaves artifacts
    // while the issue still waits for siblings. Historical terminal identities
    // on reopened issues are not evidence that their current work is merged.
    for (const record of all) {
      if (this.hasWorkingTask(record.issueId)) {
        continue;
      }
      if (record.currentPhase !== "done") {
        this.completeIfMerged(record.issueId, component);
      }
      for (const row of record.repos) {
        const leaked =
          row.prNumber === null &&
          row.mergeCompleted &&
          (row.branchName !== null || row.worktreePath !== null);
        if (leaked === false) {
          continue;
        }
        safeAudit(this.deps.audit, {
          component,
          issueId: record.issueId,
          message: `PR #${String(row.terminalPrNumber)} (${row.repo}) merge cleanup never finished — sweeping leftover branch artifacts`,
          metadata: { repo: row.repo, branchName: row.branchName, worktreePath: row.worktreePath },
        });
        try {
          await this.cleanupLocalBranchArtifacts(
            record.issueId,
            row.repo,
            row.worktreePath,
            row.branchName,
            component,
            "merge cleanup sweep",
          );
        } catch (err) {
          safeAudit(this.deps.audit, {
            component,
            issueId: record.issueId,
            message: `merge cleanup sweep failed: ${errorMessage(err)}`,
            metadata: { repo: row.repo },
          });
        }
      }
    }

    const openRows: { record: PipelineRecord; row: PipelineRepoRecord }[] = [];
    for (const record of all) {
      if (record.currentPhase === "done") {
        continue;
      }
      for (const row of record.repos) {
        if (
          row.prNumber !== null &&
          row.mergeCompleted === false &&
          row.terminalPrNumber !== row.prNumber
        ) {
          openRows.push({ record, row });
        }
      }
    }
    const candidates = await mapWithConcurrency(
      openRows,
      MERGE_LOOKUP_CONCURRENCY,
      async ({ record, row }): Promise<MergedPrCandidate | null> => {
        const prNumber = row.prNumber;
        if (prNumber === null) {
          return null;
        }
        try {
          const pr = await withTimeout(
            this.deps.sourceControls.get(row.repo).getPullRequest(prNumber),
            REMOTE_LOOKUP_TIMEOUT_MS,
            `getPullRequest ${row.repo}#${String(prNumber)}`,
          );
          if (pr === null || pr.merged === false) {
            return null;
          }
          return { record, row, pr };
        } catch (err) {
          safeAudit(this.deps.audit, {
            component,
            issueId: record.issueId,
            message: `merged-PR lookup failed for ${row.repo}#${String(prNumber)}: ${errorMessage(err)}`,
            metadata: { repo: row.repo, prNumber },
          });
          return null;
        }
      },
    );

    for (const candidate of candidates) {
      if (candidate === null) {
        continue;
      }
      const { record, row, pr } = candidate;
      try {
        safeAudit(this.deps.audit, {
          component,
          issueId: record.issueId,
          message: `PR ${row.repo}#${String(row.prNumber)} is merged but no pr-merged event was processed — replaying (check the source-control webhook on that repo)`,
          metadata: { repo: row.repo, prNumber: row.prNumber, phase: record.currentPhase },
        });
        await this.dispatchEvent(
          {
            source: "poll",
            type: "pr-merged",
            issueId: record.issueId,
            timestamp: new Date().toISOString(),
            payload: {
              branch: pr.headBranch,
              base: pr.baseBranch,
              prNumber: pr.number,
              repoName: row.repo,
            },
          },
          component,
        );
      } catch (err) {
        safeAudit(this.deps.audit, {
          component,
          issueId: record.issueId,
          message: `merged-PR reconcile failed for ${row.repo}#${String(row.prNumber)}: ${errorMessage(err)}`,
          metadata: { repo: row.repo, prNumber: row.prNumber },
        });
      }
    }
  }

  // Idempotent tail of merge processing: remove the worktree and local branch,
  // then null the record's branch info. Shared by the pr-merged event path and
  // the leak sweep in runMergedPrScan.
  private async cleanupLocalBranchArtifacts(
    issueId: string,
    repo: string,
    worktreePath: string | null,
    branchName: string | null,
    component: string,
    context: string,
  ): Promise<void> {
    const cwd = gitCwdFor(this.deps.runtime.config, repo);
    const expected = this.deps.pipelineState.getRepo(issueId, repo);
    if (
      expected?.worktreePath !== worktreePath ||
      expected.branchName !== branchName ||
      this.isCurrentMergeCleanup(expected) === false
    ) {
      return;
    }
    let worktreeRemoved = true;
    if (worktreePath !== null && existsSync(worktreePath)) {
      try {
        await this.gitRunner(["worktree", "remove", "--force", "--", worktreePath], cwd);
      } catch (err) {
        worktreeRemoved = existsSync(worktreePath) === false;
        safeAudit(this.deps.audit, {
          component,
          issueId,
          message: `${context}: git worktree remove failed: ${errorMessage(err)}`,
          metadata: { repo, worktreePath },
        });
      }
    }
    if (this.isCurrentMergeCleanup(expected) === false) {
      return;
    }
    let branchRemoved = branchName === null;
    if (branchName !== null && worktreeRemoved) {
      try {
        await this.gitRunner(["branch", "-D", "--", branchName], cwd);
        branchRemoved = true;
      } catch (err) {
        // A prior attempt may already have deleted the branch before crashing.
        // show-ref exits 1 only when this ref is absent; other errors retain
        // retry evidence instead of treating every deletion failure as success.
        try {
          await this.gitRunner(
            ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
            cwd,
          );
        } catch (lookupError) {
          branchRemoved =
            typeof lookupError === "object" &&
            lookupError !== null &&
            "code" in lookupError &&
            lookupError.code === 1;
        }
        if (branchRemoved === false) {
          safeAudit(this.deps.audit, {
            component,
            issueId,
            message: `${context}: git branch -D failed: ${errorMessage(err)}`,
            metadata: { repo, branchName },
          });
        }
      }
    }
    if (this.isCurrentMergeCleanup(expected)) {
      this.deps.pipelineState.updateBranchInfo(issueId, repo, {
        ...(branchRemoved ? { branchName: null } : {}),
        ...(worktreeRemoved ? { worktreePath: null } : {}),
      });
    }
  }

  private isCurrentMergeCleanup(expected: PipelineRepoRecord): boolean {
    const row = this.deps.pipelineState.getRepo(expected.issueId, expected.repo);
    return (
      row !== null &&
      row.mergeCompleted &&
      row.prNumber === null &&
      row.terminalPrNumber === expected.terminalPrNumber &&
      row.branchName === expected.branchName &&
      row.worktreePath === expected.worktreePath
    );
  }

  // A blocker's PR just merged into mergedBase. Every open dependent PR that
  // targeted the merged branch gets retargeted to mergedBase, and its branch
  // gets a deterministic refresh (clean merge + push, zero AI) so the PR diff
  // is immediately clean — no squash-merge duplication in the
  // review-at-the-end flow. Conflicts degrade to a PR comment; the next
  // rework resolves them.
  private async retargetAndRefreshDependents(
    mergedIssueId: string,
    mergedRepo: string,
    mergedBranch: string,
    mergedBase: string,
    component: string,
  ): Promise<void> {
    const { pipelineState, audit } = this.deps;
    for (const rec of pipelineState.listAll()) {
      // Done records can keep a stale prNumber (non-webhook completion paths
      // never null it) — skip them so the scan doesn't grow one API call per
      // completed issue forever.
      if (rec.issueId === mergedIssueId || rec.currentPhase === "done") {
        continue;
      }
      const row = rec.repos.find((r) => r.repo === mergedRepo);
      if (row === undefined || this.currentDependentRow(row) === null) {
        continue;
      }
      const prNumber = row.prNumber;
      if (prNumber === null) {
        continue;
      }
      const adapter = this.deps.sourceControls.get(mergedRepo);
      let pr;
      try {
        pr = await withTimeout(
          adapter.getPullRequest(prNumber),
          REMOTE_LOOKUP_TIMEOUT_MS,
          `getPullRequest #${String(prNumber)}`,
        );
      } catch (err) {
        audit.log({
          component,
          issueId: rec.issueId,
          message: `stack retarget: getPullRequest #${String(prNumber)} failed: ${errorMessage(err)}`,
          metadata: { repo: mergedRepo, prNumber: prNumber },
        });
        continue;
      }
      if (pr?.state !== "open" || this.currentDependentRow(row) === null) {
        continue;
      }
      if (pr.baseBranch === mergedBranch) {
        try {
          await withTimeout(
            adapter.updatePullRequestBase(pr.number, mergedBase),
            REMOTE_MUTATION_TIMEOUT_MS,
            `updatePullRequestBase #${String(pr.number)}`,
          );
          if (this.currentDependentRow(row) === null) {
            continue;
          }
          pipelineState.updateBranchInfo(rec.issueId, mergedRepo, { prBaseBranch: mergedBase });
          audit.log({
            component,
            issueId: rec.issueId,
            message: `stack retarget: PR #${String(pr.number)} base ${mergedBranch} → ${mergedBase}`,
            metadata: { repo: mergedRepo, prNumber: pr.number, mergedBase },
          });
        } catch (err) {
          audit.log({
            component,
            issueId: rec.issueId,
            message: `stack retarget: updatePullRequestBase failed: ${errorMessage(err)}`,
            metadata: { repo: mergedRepo, prNumber: pr.number },
          });
          continue;
        }
      } else if (pr.baseBranch === mergedBase && row.prBaseBranch === mergedBranch) {
        // Auto-retarget race: with head-branch auto-delete GitHub moves the
        // dependent onto mergedBase within seconds. The persisted prior base
        // proves this PR actually targeted the merged branch; a tracker Blocks
        // edge alone could be only a scheduling dependency.
        pipelineState.updateBranchInfo(rec.issueId, mergedRepo, { prBaseBranch: mergedBase });
        audit.log({
          component,
          issueId: rec.issueId,
          message: `stack retarget: PR #${String(pr.number)} already retargeted to ${mergedBase} by GitHub — refreshing anyway`,
          metadata: { repo: mergedRepo, prNumber: pr.number, mergedBase },
        });
      } else if (pr.baseBranch === mergedBase && row.prBaseBranch === null) {
        audit.log({
          component,
          issueId: rec.issueId,
          message: `stack retarget: PR #${String(pr.number)} already targets ${mergedBase}, but its prior base was not recorded — skipping refresh`,
          metadata: { repo: mergedRepo, prNumber: pr.number, mergedBranch, mergedBase },
        });
        continue;
      } else {
        continue;
      }

      if (row.branchName === null) {
        continue;
      }
      // Race guard: single worker, one scan — a dependent mid-run owns its
      // branch, so leave the refresh to its own next stack setup. The check is
      // a snapshot, not a lock: a worker starting mid-refresh can race the
      // push below. Worst case is a rejected non-fast-forward push that
      // degrades to the could-not-fold PR comment — tolerated.
      const working = this.hasWorkingTask(rec.issueId);
      if (working) {
        audit.log({
          component,
          issueId: rec.issueId,
          message: "stack refresh: skipped — issue has a working task",
          metadata: { repo: mergedRepo, branch: row.branchName },
        });
        continue;
      }
      await this.refreshDependentBranch(
        rec.issueId,
        mergedRepo,
        row.branchName,
        prNumber,
        mergedBase,
        component,
      );
    }
  }

  private async refreshDependentBranch(
    issueId: string,
    repo: string,
    depBranch: string,
    prNumber: number,
    mergedBase: string,
    component: string,
  ): Promise<void> {
    const { audit } = this.deps;
    const expected = this.deps.pipelineState.getRepo(issueId, repo);
    if (
      expected?.prNumber !== prNumber ||
      expected.branchName !== depBranch ||
      this.currentDependentRow(expected) === null ||
      this.hasWorkingTask(issueId)
    ) {
      return;
    }
    const cwd = gitCwdFor(this.deps.runtime.config, repo);
    const tempWorktree = worktreePathFor(this.deps.runtime.config, issueId, repo, "refresh");
    // Self-heal: a crash mid-refresh leaves the temp worktree registered, and
    // every later add for this issue would fail before reaching the comment.
    try {
      await this.gitRunner(["worktree", "remove", "--force", "--", tempWorktree], cwd);
    } catch {
      // nothing stale to remove — the normal case
    }
    let created = false;
    try {
      // refs/heads/ prefix: ref names may legally start with "-"; never let a
      // webhook-derived name parse as a git option. Explicit destinations so
      // origin/<X> materializes even on --single-branch clones, forced so
      // force-pushed branches don't fail the fetch.
      await this.gitRunner(
        [
          "fetch",
          "origin",
          `+refs/heads/${mergedBase}:refs/remotes/origin/${mergedBase}`,
          `+refs/heads/${depBranch}:refs/remotes/origin/${depBranch}`,
        ],
        cwd,
      );
      if (this.currentDependentRow(expected) === null || this.hasWorkingTask(issueId)) {
        return;
      }
      await this.gitRunner(
        ["worktree", "add", "--detach", tempWorktree, `origin/${depBranch}`],
        cwd,
      );
      created = true;
      await this.gitRunner(["merge", "--no-edit", `origin/${mergedBase}`], tempWorktree);
      if (this.currentDependentRow(expected) === null || this.hasWorkingTask(issueId)) {
        return;
      }
      await this.gitRunner(["push", "origin", `HEAD:${depBranch}`], tempWorktree);
      audit.log({
        component,
        issueId,
        message: `stack refresh: merged ${mergedBase} into ${depBranch} and pushed`,
        metadata: { repo, branch: depBranch, mergedBase },
      });
    } catch (err) {
      audit.log({
        component,
        issueId,
        message: `stack refresh: could not cleanly fold ${mergedBase} into ${depBranch}: ${errorMessage(err)}`,
        metadata: { repo, branch: depBranch, mergedBase },
      });
      if (created && this.currentDependentRow(expected) !== null) {
        try {
          await this.deps.sourceControls
            .get(repo)
            .postPrComment(
              prNumber,
              `stack refresh: could not cleanly fold \`${mergedBase}\` into \`${depBranch}\` (merge conflict or concurrent push) — will be resolved at next rework.`,
            );
        } catch (commentErr) {
          audit.log({
            component,
            issueId,
            message: `stack refresh: conflict comment failed: ${errorMessage(commentErr)}`,
            metadata: { repo, prNumber },
          });
        }
      }
    } finally {
      if (created) {
        try {
          await this.gitRunner(["worktree", "remove", "--force", "--", tempWorktree], cwd);
        } catch (err) {
          audit.log({
            component,
            issueId,
            message: `stack refresh: temp worktree removal failed: ${errorMessage(err)}`,
            metadata: { repo, tempWorktree },
          });
        }
      }
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", rejectPromise);
  });
}

function normalizeHeaders(raw: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  return out;
}

function extractString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function extractNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

function classifyMergedPrEvent(
  currentPhase: string | null,
  row: PipelineRepoRecord,
  mergedPrNumber: number | null,
  mergedBranch: string | null,
): "process" | "already-processed" | "stale" {
  const disposition = classifyRepoMergeTransition(currentPhase, row, mergedPrNumber);
  if (disposition !== "process") {
    return disposition;
  }
  // Webhook-only layer: with no PR number to match on, a branch mismatch is
  // the remaining signal that the event belongs to an earlier pipeline run.
  if (
    (mergedPrNumber === null || row.prNumber === null) &&
    row.branchName !== null &&
    mergedBranch !== null &&
    row.branchName !== mergedBranch
  ) {
    return "stale";
  }
  return "process";
}

async function defaultGitRunner(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd, timeout: GIT_OPERATION_TIMEOUT_MS });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async (): Promise<void> => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex++;
        // Cast past noUncheckedIndexedAccess: index < length and input is
        // dense, and skipping would leave a hole for callers to trip on.
        results[index] = await mapper(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
