import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import type { IncomingMessage, ServerResponse } from "node:http";
import { routeAiAssignment } from "../core/assignment-router.js";
import { safeAudit } from "../core/audit.js";
import type { AuditLogger } from "../core/audit.js";
import { withTimeout } from "../core/async.js";
import { errorMessage } from "../core/errors.js";
import type { TaskQueue } from "../core/queue.js";
import { classifyMergeTransition } from "../core/pipeline-state.js";
import type { PipelineStateStore } from "../core/pipeline-state.js";
import { autoTransitionRework } from "../core/rework-transition.js";
import type { RuntimeState } from "../core/runtime-state.js";
import type { PipelineEvent, PipelineRecord } from "../core/types.js";
import type { IssueTracker } from "../integrations/issue-tracker.js";
import type { PullRequest, SourceControl } from "../integrations/source-control.js";
import type { DashboardServer, RouteHandler } from "../dashboard/server.js";

export type GitRunner = (args: string[], cwd: string) => Promise<void>;

export interface WebhookServerDeps {
  issueTracker: IssueTracker;
  sourceControl: SourceControl;
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
  pr: PullRequest;
}

interface PendingMergeCleanup {
  event: PipelineEvent;
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
      validate: (headers, body) => this.deps.sourceControl.validateWebhook(headers, body),
      parse: (headers, body) => this.deps.sourceControl.parseWebhookEvent(headers, body),
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
    const { issueTracker, queue, runtime, pipelineState, audit } = this.deps;

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
        const hasPr = record !== null && record.prNumber !== null;
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
        if (currentPhase !== null) {
          await autoTransitionRework(
            { issueTracker, pipelineState, phaseGraph: runtime.phaseGraph, audit },
            event.issueId,
            currentPhase,
            taskType,
            component,
            { source: "pr-feedback" },
          );
        }
        if (queue.hasOpenTask(event.issueId, taskType)) {
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
        const mergedBranch = extractString(event.payload, "branch") ?? record?.branchName ?? null;
        const mergedBase = extractString(event.payload, "base") ?? record?.prBaseBranch ?? null;
        if (record === null) {
          this.pendingMergeCleanup.delete(event.issueId);
          audit.log({
            component,
            issueId: event.issueId,
            message: "PR merged — no pipeline record, skipping local cleanup",
            metadata: {},
          });
          break;
        }
        const disposition = classifyMergedPrEvent(record, mergedPrNumber, mergedBranch);
        if (disposition !== "process") {
          this.pendingMergeCleanup.delete(event.issueId);
          audit.log({
            component,
            issueId: event.issueId,
            message:
              disposition === "already-processed"
                ? `PR #${String(mergedPrNumber)} merge cleanup was already processed — ignoring duplicate delivery`
                : `PR #${String(mergedPrNumber)} merged, but it belongs to an earlier pipeline run — ignoring stale cleanup`,
            metadata: {
              mergedPrNumber,
              currentPrNumber: record.prNumber,
              terminalPrNumber: record.terminalPrNumber,
              mergedBranch,
              currentBranch: record.branchName,
            },
          });
          break;
        }
        const working = queue
          .listByStatus("working")
          .some((task) => task.issueId === event.issueId);
        if (working) {
          const expectedPrNumber = mergedPrNumber ?? record.prNumber;
          this.pendingMergeCleanup.set(event.issueId, {
            expectedPrNumber,
            event: {
              ...event,
              payload: {
                ...event.payload,
                ...(expectedPrNumber === null ? {} : { prNumber: expectedPrNumber }),
                ...(mergedBranch === null ? {} : { branch: mergedBranch }),
                ...(mergedBase === null ? {} : { base: mergedBase }),
              },
            },
          });
          audit.log({
            component,
            issueId: event.issueId,
            message: "PR merged — cleanup deferred because the issue has a working task",
            metadata: {
              prNumber: record.prNumber,
              worktreePath: record.worktreePath,
              branchName: record.branchName,
            },
          });
          break;
        }

        const transition = pipelineState.markPrMerged(event.issueId, mergedPrNumber);
        if (transition !== "processed") {
          this.pendingMergeCleanup.delete(event.issueId);
          audit.log({
            component,
            issueId: event.issueId,
            message: `PR merge cleanup skipped after state recheck: ${transition}`,
            metadata: { mergedPrNumber },
          });
          break;
        }
        this.pendingMergeCleanup.delete(event.issueId);
        const cancelledTasks = queue.cancelPendingForIssue(
          event.issueId,
          "Cancelled — pull request merged",
        );

        await this.cleanupLocalBranchArtifacts(
          event.issueId,
          record.worktreePath,
          record.branchName,
          component,
          "pr-merged cleanup",
        );
        audit.log({
          component,
          issueId: event.issueId,
          message: "PR merged — pipeline marked done, local cleanup complete",
          metadata: {
            hadWorktree: record.worktreePath !== null,
            hadBranch: record.branchName !== null,
            cancelledTasks,
          },
        });

        // Stacked dependents: retarget their PRs off the merged branch and
        // deterministically fold the merged base into their branches.
        if (mergedBranch !== null && mergedBase !== null) {
          const run = this.refreshChain.then(() =>
            this.retargetAndRefreshDependents(event.issueId, mergedBranch, mergedBase, component),
          );
          this.refreshChain = run.catch(() => undefined);
          await run;
        }

        queue.releaseDeferred();
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
    const pending = this.pendingMergeCleanup.get(issueId);
    if (pending === undefined) {
      return;
    }
    const record = this.deps.pipelineState.get(issueId);
    const prChanged =
      record !== null &&
      (pending.expectedPrNumber === null
        ? record.prNumber !== null
        : record.prNumber !== null && record.prNumber !== pending.expectedPrNumber);
    if (record === null || prChanged) {
      this.pendingMergeCleanup.delete(issueId);
      safeAudit(this.deps.audit, {
        component: "webhook-reconcile",
        issueId,
        message: "Deferred merged-PR cleanup discarded because the pipeline now has a different PR",
        metadata: {
          expectedPrNumber: pending.expectedPrNumber,
          currentPrNumber: record?.prNumber ?? null,
        },
      });
      return;
    }
    await this.dispatchEvent(pending.event, "webhook-reconcile");
  }

  async drain(): Promise<void> {
    const scan = this.mergeScanPromise;
    if (scan !== null) {
      await scan;
    }
    await this.refreshChain;
  }

  private async runMergedPrScan(): Promise<void> {
    const component = "webhook-reconcile";
    const { pipelineState, sourceControl } = this.deps;
    const all = pipelineState.listAll();

    // A crash between markPrMerged's commit and the git cleanup leaves exactly
    // this signature — done, pr_number nulled, terminal PR recorded, branch
    // info still set. No other path produces it (markDone keeps pr_number),
    // and the replay filter below can never see it again, so finish the
    // cleanup from local state alone.
    for (const record of all) {
      const leaked =
        record.currentPhase === "done" &&
        record.prNumber === null &&
        record.terminalPrNumber !== null &&
        (record.branchName !== null || record.worktreePath !== null);
      if (leaked === false) {
        continue;
      }
      safeAudit(this.deps.audit, {
        component,
        issueId: record.issueId,
        message: `PR #${String(record.terminalPrNumber)} merge cleanup never finished — sweeping leftover branch artifacts`,
        metadata: { branchName: record.branchName, worktreePath: record.worktreePath },
      });
      try {
        await this.cleanupLocalBranchArtifacts(
          record.issueId,
          record.worktreePath,
          record.branchName,
          component,
          "merge cleanup sweep",
        );
      } catch (err) {
        safeAudit(this.deps.audit, {
          component,
          issueId: record.issueId,
          message: `merge cleanup sweep failed: ${errorMessage(err)}`,
          metadata: {},
        });
      }
    }

    const records = all.filter(
      (record) =>
        record.prNumber !== null &&
        record.currentPhase !== "done" &&
        record.terminalPrNumber !== record.prNumber,
    );
    const candidates = await mapWithConcurrency(
      records,
      MERGE_LOOKUP_CONCURRENCY,
      async (record): Promise<MergedPrCandidate | null> => {
        const prNumber = record.prNumber;
        if (prNumber === null) {
          return null;
        }
        try {
          const pr = await withTimeout(
            sourceControl.getPullRequest(prNumber),
            REMOTE_LOOKUP_TIMEOUT_MS,
            `getPullRequest #${String(prNumber)}`,
          );
          if (pr === null || pr.merged === false) {
            return null;
          }
          return { record, pr };
        } catch (err) {
          safeAudit(this.deps.audit, {
            component,
            issueId: record.issueId,
            message: `merged-PR lookup failed for #${String(prNumber)}: ${errorMessage(err)}`,
            metadata: { prNumber },
          });
          return null;
        }
      },
    );

    for (const candidate of candidates) {
      if (candidate === null) {
        continue;
      }
      const { record, pr } = candidate;
      try {
        safeAudit(this.deps.audit, {
          component,
          issueId: record.issueId,
          message: `PR #${String(record.prNumber)} is merged but no pr-merged event was processed — replaying (check the source-control webhook)`,
          metadata: { prNumber: record.prNumber, phase: record.currentPhase },
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
            },
          },
          component,
        );
      } catch (err) {
        safeAudit(this.deps.audit, {
          component,
          issueId: record.issueId,
          message: `merged-PR reconcile failed for #${String(record.prNumber)}: ${errorMessage(err)}`,
          metadata: { prNumber: record.prNumber },
        });
      }
    }
  }

  // Idempotent tail of merge processing: remove the worktree and local branch,
  // then null the record's branch info. Shared by the pr-merged event path and
  // the leak sweep in runMergedPrScan.
  private async cleanupLocalBranchArtifacts(
    issueId: string,
    worktreePath: string | null,
    branchName: string | null,
    component: string,
    context: string,
  ): Promise<void> {
    const projectDir = this.deps.runtime.config.project.directory;
    if (worktreePath !== null && existsSync(worktreePath)) {
      try {
        await this.gitRunner(["worktree", "remove", "--force", "--", worktreePath], projectDir);
      } catch (err) {
        safeAudit(this.deps.audit, {
          component,
          issueId,
          message: `${context}: git worktree remove failed: ${errorMessage(err)}`,
          metadata: { worktreePath },
        });
      }
    }
    if (branchName !== null) {
      try {
        await this.gitRunner(["branch", "-D", "--", branchName], projectDir);
      } catch (err) {
        safeAudit(this.deps.audit, {
          component,
          issueId,
          message: `${context}: git branch -D failed: ${errorMessage(err)}`,
          metadata: { branchName },
        });
      }
    }
    this.deps.pipelineState.updateBranchInfo(issueId, {
      branchName: null,
      worktreePath: null,
    });
  }

  // A blocker's PR just merged into mergedBase. Every open dependent PR that
  // targeted the merged branch gets retargeted to mergedBase, and its branch
  // gets a deterministic refresh (clean merge + push, zero AI) so the PR diff
  // is immediately clean — no squash-merge duplication in the
  // review-at-the-end flow. Conflicts degrade to a PR comment; the next
  // rework resolves them.
  private async retargetAndRefreshDependents(
    mergedIssueId: string,
    mergedBranch: string,
    mergedBase: string,
    component: string,
  ): Promise<void> {
    const { pipelineState, sourceControl, queue, audit } = this.deps;
    const workingIssueIds = new Set(
      queue
        .listByStatus("working")
        .map((task) => task.issueId)
        .filter((issueId): issueId is string => issueId !== null),
    );
    for (const rec of pipelineState.listAll()) {
      // Done records can keep a stale prNumber (non-webhook completion paths
      // never null it) — skip them so the scan doesn't grow one API call per
      // completed issue forever.
      if (rec.issueId === mergedIssueId || rec.prNumber === null || rec.currentPhase === "done") {
        continue;
      }
      let pr;
      try {
        pr = await withTimeout(
          sourceControl.getPullRequest(rec.prNumber),
          REMOTE_LOOKUP_TIMEOUT_MS,
          `getPullRequest #${String(rec.prNumber)}`,
        );
      } catch (err) {
        audit.log({
          component,
          issueId: rec.issueId,
          message: `stack retarget: getPullRequest #${String(rec.prNumber)} failed: ${errorMessage(err)}`,
          metadata: { prNumber: rec.prNumber },
        });
        continue;
      }
      if (pr?.state !== "open") {
        continue;
      }
      if (pr.baseBranch === mergedBranch) {
        try {
          await withTimeout(
            sourceControl.updatePullRequestBase(pr.number, mergedBase),
            REMOTE_MUTATION_TIMEOUT_MS,
            `updatePullRequestBase #${String(pr.number)}`,
          );
          pipelineState.updateBranchInfo(rec.issueId, { prBaseBranch: mergedBase });
          audit.log({
            component,
            issueId: rec.issueId,
            message: `stack retarget: PR #${String(pr.number)} base ${mergedBranch} → ${mergedBase}`,
            metadata: { prNumber: pr.number, mergedBase },
          });
        } catch (err) {
          audit.log({
            component,
            issueId: rec.issueId,
            message: `stack retarget: updatePullRequestBase failed: ${errorMessage(err)}`,
            metadata: { prNumber: pr.number },
          });
          continue;
        }
      } else if (pr.baseBranch === mergedBase && rec.prBaseBranch === mergedBranch) {
        // Auto-retarget race: with head-branch auto-delete GitHub moves the
        // dependent onto mergedBase within seconds. The persisted prior base
        // proves this PR actually targeted the merged branch; a tracker Blocks
        // edge alone could be only a scheduling dependency.
        pipelineState.updateBranchInfo(rec.issueId, { prBaseBranch: mergedBase });
        audit.log({
          component,
          issueId: rec.issueId,
          message: `stack retarget: PR #${String(pr.number)} already retargeted to ${mergedBase} by GitHub — refreshing anyway`,
          metadata: { prNumber: pr.number, mergedBase },
        });
      } else if (pr.baseBranch === mergedBase && rec.prBaseBranch === null) {
        audit.log({
          component,
          issueId: rec.issueId,
          message: `stack retarget: PR #${String(pr.number)} already targets ${mergedBase}, but its prior base was not recorded — skipping refresh`,
          metadata: { prNumber: pr.number, mergedBranch, mergedBase },
        });
        continue;
      } else {
        continue;
      }

      if (rec.branchName === null) {
        continue;
      }
      // Race guard: single worker, one scan — a dependent mid-run owns its
      // branch, so leave the refresh to its own next stack setup. The check is
      // a snapshot, not a lock: a worker starting mid-refresh can race the
      // push below. Worst case is a rejected non-fast-forward push that
      // degrades to the could-not-fold PR comment — tolerated.
      const working = workingIssueIds.has(rec.issueId);
      if (working) {
        audit.log({
          component,
          issueId: rec.issueId,
          message: "stack refresh: skipped — issue has a working task",
          metadata: { branch: rec.branchName },
        });
        continue;
      }
      await this.refreshDependentBranch(
        rec.issueId,
        rec.branchName,
        rec.prNumber,
        mergedBase,
        component,
      );
    }
  }

  private async refreshDependentBranch(
    issueId: string,
    depBranch: string,
    prNumber: number,
    mergedBase: string,
    component: string,
  ): Promise<void> {
    const { sourceControl, audit } = this.deps;
    const projectDir = this.deps.runtime.config.project.directory;
    const tempWorktree = join(projectDir, ".redqueen", "worktrees", `refresh-${issueId}`);
    // Self-heal: a crash mid-refresh leaves the temp worktree registered, and
    // every later add for this issue would fail before reaching the comment.
    try {
      await this.gitRunner(["worktree", "remove", "--force", "--", tempWorktree], projectDir);
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
        projectDir,
      );
      await this.gitRunner(
        ["worktree", "add", "--detach", tempWorktree, `origin/${depBranch}`],
        projectDir,
      );
      created = true;
      await this.gitRunner(["merge", "--no-edit", `origin/${mergedBase}`], tempWorktree);
      await this.gitRunner(["push", "origin", `HEAD:${depBranch}`], tempWorktree);
      audit.log({
        component,
        issueId,
        message: `stack refresh: merged ${mergedBase} into ${depBranch} and pushed`,
        metadata: { branch: depBranch, mergedBase },
      });
    } catch (err) {
      audit.log({
        component,
        issueId,
        message: `stack refresh: could not cleanly fold ${mergedBase} into ${depBranch}: ${errorMessage(err)}`,
        metadata: { branch: depBranch, mergedBase },
      });
      if (created) {
        try {
          await sourceControl.postPrComment(
            prNumber,
            `stack refresh: could not cleanly fold \`${mergedBase}\` into \`${depBranch}\` (merge conflict or concurrent push) — will be resolved at next rework.`,
          );
        } catch (commentErr) {
          audit.log({
            component,
            issueId,
            message: `stack refresh: conflict comment failed: ${errorMessage(commentErr)}`,
            metadata: { prNumber },
          });
        }
      }
    } finally {
      if (created) {
        try {
          await this.gitRunner(["worktree", "remove", "--force", "--", tempWorktree], projectDir);
        } catch (err) {
          audit.log({
            component,
            issueId,
            message: `stack refresh: temp worktree removal failed: ${errorMessage(err)}`,
            metadata: { tempWorktree },
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
  record: PipelineRecord,
  mergedPrNumber: number | null,
  mergedBranch: string | null,
): "process" | "already-processed" | "stale" {
  const disposition = classifyMergeTransition(record, mergedPrNumber);
  if (disposition !== "process") {
    return disposition;
  }
  // Webhook-only layer: with no PR number to match on, a branch mismatch is
  // the remaining signal that the event belongs to an earlier pipeline run.
  if (
    record.prNumber === null &&
    record.branchName !== null &&
    mergedBranch !== null &&
    record.branchName !== mergedBranch
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
