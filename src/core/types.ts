// --- Phase types ---

export type PhaseType = "automated" | "human-gate";

export type AssignTo = "ai" | "human";

export interface PhaseDefinition {
  name: string;
  label: string;
  type: PhaseType;
  skill?: string;
  next: string;
  onFail?: string;
  rework?: string;
  maxIterations?: number;
  escalateTo?: string;
  assignTo: AssignTo;
  // Selects which counter feeds the skill's `iterationCount`. Replaces the
  // brittle phase-name string match in skill-context. "review" → review_iterations,
  // "feedback" → feedback_iterations, "none" → 0. Omitted phases fall back to the
  // legacy name-based heuristic so existing configs keep working.
  iterationCounter?: "review" | "feedback" | "none";
  // When set, the phase is only executed if a PR's presence matches this value.
  // true  → phase consumes PR-level feedback (e.g. code-feedback); skip when no PR.
  // false → phase consumes tracker-level feedback pre-PR (e.g. spec-feedback); skip when a PR exists.
  requiresPr?: boolean;
  // When true, a successful run of this phase resets review_iterations to 0.
  // Used by code-review and any custom reviewer phase that closes a review loop:
  // a downstream failure (e.g. testing) should re-enter the loop with a fresh budget.
  resetReviewIterationsOnPass?: boolean;
  // When true, a non-zero worker exit skips the global crash-retry and routes
  // immediately via onFail/escalateTo. Used by code-review: the reviewer's
  // `exit 1` is a deliberate "request changes" verdict, not a crash — retrying
  // it would re-run the reviewer (and re-post the review) maxRetries times on
  // every rework cycle. The onFail iteration counting + escalation still apply.
  skipRetryOnFailure?: boolean;
  // When true, this phase authors the spec artifact (the prompt-writer phases).
  // On success the orchestrator verifies a non-empty spec actually landed on the
  // tracker before advancing; a phase that exits 0 without writing one is routed
  // through the failure path (retry → onFail) instead of parking an empty spec
  // at the next human gate.
  producesSpec?: boolean;
  // When true, this phase consumes the spec (the coder phase). Before dispatch the
  // orchestrator verifies a non-empty spec exists; if none does — e.g. a ticket
  // moved straight to coding without ever being specced — the worker is never
  // launched and the issue is kicked back to the spec-producing entry phase.
  requiresSpec?: boolean;
}

export class PhaseGraph {
  private readonly phases: ReadonlyMap<string, PhaseDefinition>;
  readonly size: number;

  constructor(definitions: readonly PhaseDefinition[]) {
    const map = new Map<string, PhaseDefinition>();
    for (const def of definitions) {
      map.set(def.name, def);
    }
    this.phases = map;
    this.size = map.size;
  }

  getPhase(name: string): PhaseDefinition | undefined {
    return this.phases.get(name);
  }

  getNext(name: string): string | undefined {
    return this.phases.get(name)?.next;
  }

  getOnFail(name: string): string | undefined {
    return this.phases.get(name)?.onFail;
  }

  getRework(name: string): string | undefined {
    return this.phases.get(name)?.rework;
  }

  getEscalateTo(name: string): string | undefined {
    return this.phases.get(name)?.escalateTo;
  }

  isHumanGate(name: string): boolean {
    return this.phases.get(name)?.type === "human-gate";
  }

  getAutomatedPhases(): PhaseDefinition[] {
    return [...this.phases.values()].filter((p) => p.type === "automated");
  }

  getHumanGates(): PhaseDefinition[] {
    return [...this.phases.values()].filter((p) => p.type === "human-gate");
  }

  getEntryPhases(): PhaseDefinition[] {
    const referenced = new Set<string>();
    for (const phase of this.phases.values()) {
      // Human-gates don't auto-advance via `next` — a human manually
      // transitions the ticket, so that field is documentation of the exit
      // path rather than an automated forward edge. Counting it here would
      // incorrectly classify a gate's exit target as "downstream" when the
      // target is actually an entry phase the gate returns to (e.g.
      // spec-awaiting-info.next = spec-writing).
      const targets =
        phase.type === "human-gate"
          ? [phase.onFail, phase.rework, phase.escalateTo]
          : [phase.next, phase.onFail, phase.rework, phase.escalateTo];
      for (const target of targets) {
        if (target !== undefined && target !== "done") {
          referenced.add(target);
        }
      }
    }
    return [...this.phases.values()].filter((p) => referenced.has(p.name) === false);
  }

  getAllPhases(): PhaseDefinition[] {
    return [...this.phases.values()];
  }

  getPhaseNames(): string[] {
    return [...this.phases.keys()];
  }

  has(name: string): boolean {
    return this.phases.has(name);
  }
}

// --- Task types ---

export type TaskStatus = "ready" | "working" | "complete" | "failed";

export interface Task {
  id: string;
  type: string;
  issueId: string | null;
  status: TaskStatus;
  description: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: string | null;
  retryCount: number;
  metadata: Record<string, unknown>;
}

export interface NewTask {
  type: string;
  issueId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

// --- Pipeline state ---

export interface PipelineRecord {
  issueId: string;
  currentPhase: string | null;
  priorPhase: string | null;
  branchName: string | null;
  prNumber: number | null;
  worktreePath: string | null;
  reviewIterations: number;
  feedbackIterations: number;
  specContent: string | null;
  priorContext: string | null;
  delegatorAccountId: string | null;
  // Set by the spec-writing skill via `redqueen spec meta`. Null on records
  // that haven't run spec-writing yet (or on pre-migration rows). The
  // orchestrator's skip-gate fast-path only fires on an explicit zero.
  openQuestionCount: number | null;
  createdAt: string;
  updatedAt: string;
}

// --- Orchestrator state ---

export type OrchestratorStatus = "idle" | "working" | "stopped" | "crashed";

export interface OrchestratorState {
  status: OrchestratorStatus;
  currentTaskId: string | null;
  lastPoll: string | null;
  completedCount: number;
  errorCount: number;
  startedAt: string | null;
}

// --- Skill context ---

export interface SkillModuleContext {
  buildCommand: string;
  testCommandTargeted: string | null;
  testCommandFull: string | null;
}

export interface SkillContext {
  issueId: string;
  phaseName: string;
  phaseLabel: string;
  skillName: string;
  buildCommands: string;
  testCommands: string;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  branchPrefix: string;
  module: SkillModuleContext | null;
  branchName: string | null;
  prNumber: number | null;
  specContent: string | null;
  priorContext: string | null;
  priorPhase: string | null;
  iterationCount: number;
  maxIterations: number;
  codebaseMapPath: string | null;
  projectDir: string;
}

// --- Events ---

export type PipelineEventSource = "webhook" | "poll";

export type PipelineEventType =
  | "phase-change"
  | "pr-feedback"
  | "pr-merged"
  | "assignment-change"
  | "new-ticket";

export interface PipelineEvent {
  source: PipelineEventSource;
  type: PipelineEventType;
  issueId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

// --- Usage & cost ---

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface PhaseUsage {
  issueId: string;
  phaseName: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  updatedAt: string;
}

export interface PhaseCostRow {
  phase: string;
  iterations: number;
  usage: RunUsage;
  costUsd: number;
}

export interface CostBreakdown {
  totalCostUsd: number;
  phases: PhaseCostRow[];
  currency: "USD";
  model: string;
  updatedAt: string;
}

// --- Shared integration types ---

export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewThreadComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewThread {
  threadId: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: ReviewThreadComment[];
}

export interface GetReviewThreadsOptions {
  unresolvedOnly?: boolean;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}
