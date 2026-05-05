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
  priority?: number;
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
      for (const target of [phase.next, phase.onFail, phase.rework, phase.escalateTo]) {
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
  priority: number;
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
  priority?: number;
  issueId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

// --- Pipeline state ---

export interface PipelineRecord {
  issueId: string;
  currentPhase: string | null;
  branchName: string | null;
  prNumber: number | null;
  worktreePath: string | null;
  reviewIterations: number;
  feedbackIterations: number;
  specContent: string | null;
  priorContext: string | null;
  delegatorAccountId: string | null;
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

// --- Shared integration types ---

export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}
