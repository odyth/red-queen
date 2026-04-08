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
├── core/              # State machine, queue, config — always required
│   ├── orchestrator.ts
│   ├── state-machine.ts
│   └── worker-pool.ts
├── integrations/      # Issue tracker and source control adapters
│   ├── jira/          # Jira adapter
│   ├── github/        # GitHub source control adapter
│   └── github-issues/ # GitHub Issues as issue tracker
├── skills/            # Default skill templates
├── webhook/           # Optional webhook server module
└── index.ts           # Package entry point
```

## Architecture Principles

These are deliberate design decisions, not gaps to fill:

1. **Deterministic orchestration** — The state machine is pure logic. No AI tokens spent on routing, scheduling, or decision-making. If you're tempted to add LLM calls to the orchestrator, don't.

2. **Isolated skills** — Each skill (prompt-writer, coder, reviewer, tester, comment-handler) gets its own focused prompt and runs in isolation. Don't merge skills or create mega-prompts.

3. **Human gates are first-class** — Human review checkpoints are core workflow, not afterthoughts. Don't add ways to bypass them.

4. **Adapter pattern for integrations** — All issue trackers implement `IssueTracker` interface, all source control implements `SourceControl` interface. New integrations = new adapter, never modify core.

5. **Simple infrastructure** — JSON state files, no databases, no Kubernetes, no heavy frameworks. The simplicity is the feature.

## Key Interfaces

```typescript
// All issue tracker integrations must implement this
interface IssueTracker {
  getTask(id: string): Promise<Task>;
  updatePhase(id: string, phase: Phase): void;
  assignTo(id: string, user: string): void;
  addComment(id: string, body: string): void;
  getComments(id: string): Promise<Comment[]>;
  getSpec(id: string): Promise<string>;
  setSpec(id: string, spec: string): void;
}
```

## State Machine Phases

```
Prompt Writing → Prompt Review (HUMAN GATE) → Coding → Code Review → Testing → Human Review (HUMAN GATE)
```

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
- Add heavy dependencies (databases, container orchestrators, message queues)
- Bypass or weaken human gate checkpoints
- Commit `.env`, `config.local.json`, or `webhook-secrets.json` files
