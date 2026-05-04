import type { AuditLogger } from "./audit.js";
import type { PipelineStateStore } from "./pipeline-state.js";
import type { TaskQueue } from "./queue.js";
import { reconcile } from "./reconciler.js";
import type { PhaseGraph } from "./types.js";
import type { IssueTracker } from "../integrations/issue-tracker.js";

export interface PollerDeps {
  issueTracker: IssueTracker;
  queue: TaskQueue;
  phaseGraph: PhaseGraph;
  pipelineState: PipelineStateStore;
  audit: AuditLogger;
  onTick?: () => void;
}

export class Poller {
  private readonly deps: PollerDeps;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: PollerDeps, intervalMs: number) {
    this.deps = deps;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await reconcile({
        issueTracker: this.deps.issueTracker,
        queue: this.deps.queue,
        phaseGraph: this.deps.phaseGraph,
        pipelineState: this.deps.pipelineState,
        audit: this.deps.audit,
      });
      if (this.deps.onTick) {
        this.deps.onTick();
      }
    } catch (err) {
      this.deps.audit.log({
        component: "poller",
        issueId: null,
        message: `Poller tick failed: ${errorMessage(err)}`,
        metadata: {},
      });
    } finally {
      this.running = false;
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
