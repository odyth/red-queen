# AGENTS.md — AI Agent Instructions for Red Queen

This file provides context for any AI coding agent working in this repository.

## Project Overview

Red Queen is a deterministic, zero-token orchestrator for AI coding agents. It manages a full SDLC pipeline (spec writing → coding → review → testing → human review) using a state machine that dispatches isolated AI workers. The orchestrator itself spends zero AI tokens — it's pure deterministic logic. AI does the work; the orchestrator decides what work to do.

**Key vocabulary:** "The Hive" (worker pool), "Agents" (skills/workers), "Gates" (human review checkpoints).

## Build & Quality Commands

```bash
npm run build          # Compile TypeScript (tsc)
npm run dev            # Watch mode (tsc --watch)
npm run lint           # ESLint strict + stylistic rules
npm run lint:fix       # ESLint with auto-fix
npm run format         # Prettier auto-format
npm run format:check   # Prettier check (no write)
npm run check          # Build + lint + format check (run this before committing)
npm run test           # Run tests
```

**After every code change, run `npm run check` to verify.** This project enforces strict TypeScript compilation, ESLint rules, and Prettier formatting. All three must pass.

## Code Style

- **Indentation:** 2 spaces, no tabs
- **Quotes:** Double quotes
- **Semicolons:** Always
- **Trailing commas:** Always
- **Line width:** 100 characters
- **Line endings:** LF
- **Naming:** PascalCase for classes/interfaces/types, camelCase for variables/functions, prefix interfaces with `I`
- **Type safety:** `strict: true` in tsconfig — no implicit any, no unchecked nulls
- **Imports:** Use ESM (`import`/`export`), not CommonJS (`require`)

The full rules are enforced by ESLint (`eslint.config.js`) and Prettier (`.prettierrc`). If the tools say it's wrong, fix it — don't suppress.

## Project Structure

```
src/
├── cli/               # CLI commands (init, start, stop, status)
├── core/              # State machine, queue, config, audit — always required
│   ├── orchestrator.ts  # Orchestrator class (stub — Phase 3)
│   ├── types.ts         # All shared types: phases, tasks, pipeline, events
│   ├── config.ts        # Zod config schema, YAML loading, phase graph validation
│   ├── defaults.ts      # Default SDLC phase configuration
│   ├── database.ts      # SQLite schema init (RedQueenDatabase)
│   ├── queue.ts         # TaskQueue interface + SqliteTaskQueue
│   ├── pipeline-state.ts # PipelineStateStore + OrchestratorStateStore
│   ├── audit.ts         # AuditLogger interface + DualWriteAuditLogger
│   └── __tests__/       # Vitest tests for all core modules
├── integrations/      # Issue tracker and source control adapters
│   ├── issue-tracker.ts # IssueTracker interface + Issue type
│   ├── source-control.ts # SourceControl interface + PR types
│   ├── jira/          # Jira adapter (Phase 5)
│   ├── github/        # GitHub source control adapter (Phase 5)
│   └── github-issues/ # GitHub Issues as issue tracker (Phase 5)
├── skills/            # Default skill templates (Phase 4)
├── webhook/           # Optional webhook server module (Phase 3)
└── index.ts           # Package entry point — re-exports everything
```

## Architecture Principles

These are deliberate design decisions, not gaps to fill:

1. **Deterministic orchestration** — The state machine is pure logic. No AI tokens spent on routing, scheduling, or decision-making. If you're tempted to add LLM calls to the orchestrator, don't.

2. **Isolated skills** — Each skill (prompt-writer, coder, reviewer, tester, comment-handler) gets its own focused prompt and runs in isolation. Don't merge skills or create mega-prompts.

3. **Human gates are first-class** — Human review checkpoints are core workflow, not afterthoughts. Don't add ways to bypass them.

4. **Adapter pattern for integrations** — All issue trackers implement `IssueTracker` interface, all source control implements `SourceControl` interface. New integrations = new adapter, never modify core.

5. **Simple infrastructure** — SQLite for persistence (task queue, pipeline state, audit log), flat files for human-readable audit. No Kubernetes, no heavy frameworks. The simplicity is the feature.

## Key Interfaces

```typescript
// All issue tracker integrations must implement this (src/integrations/issue-tracker.ts)
interface IssueTracker {
  getIssue(issueId: string): Promise<Issue>;
  listIssuesByPhase(phaseName: string): Promise<Issue[]>;
  getPhase(issueId: string): Promise<string | null>;
  setPhase(issueId: string, phaseName: string): Promise<void>;
  assignToAi(issueId: string): Promise<void>;
  assignToHuman(issueId: string): Promise<void>;
  getSpec(issueId: string): Promise<string | null>;
  setSpec(issueId: string, content: string): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
  getComments(issueId: string): Promise<Comment[]>;
  transitionTo(issueId: string, status: string): Promise<void>;
  validateWebhook(headers: Record<string, string>, body: string): boolean;
  parseWebhookEvent(headers: Record<string, string>, body: string): PipelineEvent | null;
  validateConfig(config: Record<string, unknown>): ValidationResult;
  validatePhaseMapping(phaseNames: string[]): ValidationResult;
}

// Source control (src/integrations/source-control.ts)
interface SourceControl {
  createBranch(name: string, from: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  branchExists(name: string): Promise<boolean>;
  createPullRequest(options: CreatePROptions): Promise<PullRequest>;
  getPullRequest(issueId: string): Promise<PullRequest | null>;
  getPullRequestDiff(prNumber: number): Promise<string>;
  mergePullRequest(prNumber: number): Promise<void>;
  postReview(prNumber: number, body: string, verdict: "approve" | "request-changes"): Promise<void>;
  dismissStaleReviews(prNumber: number): Promise<void>;
  getReviewComments(prNumber: number): Promise<Comment[]>;
  replyToComment(prNumber: number, commentId: number, body: string): Promise<void>;
  validateWebhook(headers: Record<string, string>, body: string): boolean;
  parseWebhookEvent(headers: Record<string, string>, body: string): PipelineEvent | null;
  validateConfig(config: Record<string, unknown>): void;
}

// Task queue (src/core/queue.ts) — synchronous SQLite-backed
interface TaskQueue {
  enqueue(task: NewTask): Task;
  dequeue(): Task | null;
  markWorking(taskId: string): boolean;
  markComplete(taskId: string, result: string): boolean;
  markFailed(taskId: string, error: string): boolean;
  hasOpenTask(issueId: string, taskType: string): boolean;
  listByStatus(status: TaskStatus): Task[];
  getTask(taskId: string): Task | null;
  purgeOld(olderThanDays: number): number;
}
```

## State Machine Phases

Phases are **dynamic** — defined in `redqueen.yaml`, not hardcoded. The default SDLC flow:

```
spec-writing → spec-review (HUMAN GATE) → coding → code-review → testing → human-review (HUMAN GATE)
                 ↓ rework                              ↓ onFail                ↓ onFail     ↓ rework
              spec-feedback                           coding                  coding     code-feedback
```

Feedback loops: `spec-feedback` ↔ `spec-review`, `code-feedback` ↔ `code-review`
Escalation: `blocked` (human gate) after max iterations

- Max 3 iterations on any rework loop before escalating to human
- Failed phases re-enter from Coding, not from the beginning
- Human gates cannot be skipped programmatically

## Testing

- Write tests for state machine logic and adapter implementations
- Core orchestration logic must have unit tests
- Integration adapters should be testable with mocked HTTP responses

## Do Not

- Add AI/LLM calls to the orchestrator or state machine
- Suppress ESLint or TypeScript errors without explicit approval
- Add heavy dependencies (container orchestrators, message queues, ORMs)
- Bypass or weaken human gate checkpoints
- Commit `.env`, `config.local.json`, or `webhook-secrets.json` files
