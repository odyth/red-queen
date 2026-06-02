import type { PhaseDefinition } from "./types.js";

export const DEFAULT_PHASES: PhaseDefinition[] = [
  {
    name: "spec-writing",
    label: "Spec Writing",
    type: "automated",
    skill: "prompt-writer",
    next: "spec-review",
    onFail: "spec-awaiting-info",
    assignTo: "ai",
    producesSpec: true,
  },
  {
    name: "spec-review",
    label: "Spec Review",
    type: "human-gate",
    next: "coding",
    rework: "spec-feedback",
    assignTo: "human",
  },
  {
    name: "spec-feedback",
    label: "Spec Feedback",
    type: "automated",
    skill: "prompt-writer",
    next: "spec-review",
    maxIterations: 3,
    escalateTo: "blocked",
    assignTo: "ai",
    requiresPr: false,
    producesSpec: true,
  },
  {
    name: "spec-awaiting-info",
    label: "Awaiting Info",
    type: "human-gate",
    next: "spec-writing",
    assignTo: "human",
  },
  {
    name: "coding",
    label: "Coding",
    type: "automated",
    skill: "coder",
    next: "code-review",
    assignTo: "ai",
    // coding re-enters from code-review (and testing) on failure; review_iterations
    // is bumped before the transition, so the coder sees the correct rework round.
    iterationCounter: "review",
    // The coder needs a spec to work from. If a ticket reaches coding without one
    // (e.g. moved straight to coding by a human), the orchestrator kicks it back to
    // spec-writing instead of launching the worker.
    requiresSpec: true,
  },
  {
    name: "code-review",
    label: "Code Review",
    type: "automated",
    skill: "reviewer",
    next: "testing",
    onFail: "coding",
    maxIterations: 3,
    escalateTo: "human-review",
    assignTo: "ai",
    resetReviewIterationsOnPass: true,
    // The reviewer's `exit 1` means "request changes", not "crashed". Skip the
    // crash-retry gate so a single request-changes routes straight to coding
    // (one reviewer run, one posted review) instead of retrying maxRetries times.
    skipRetryOnFailure: true,
  },
  {
    name: "testing",
    label: "Testing",
    type: "automated",
    skill: "tester",
    next: "human-review",
    onFail: "coding",
    assignTo: "ai",
  },
  {
    name: "human-review",
    label: "Human Review",
    type: "human-gate",
    next: "done",
    rework: "code-feedback",
    assignTo: "human",
  },
  {
    name: "code-feedback",
    label: "Code Feedback",
    type: "automated",
    skill: "comment-handler",
    next: "code-review",
    maxIterations: 3,
    escalateTo: "human-review",
    assignTo: "ai",
    requiresPr: true,
  },
  {
    name: "blocked",
    label: "Blocked",
    type: "human-gate",
    next: "coding",
    assignTo: "human",
  },
];
