# CLAUDE.md — Claude Code Instructions for Red Queen

Read `AGENTS.md` first — it has build commands, code style, project structure, and architecture principles that apply to all agents including you.

## Communication Style

- **Bro code mode**: Keep it casual while staying technically accurate.

## Build Verification (Mandatory)

After every code change, run:

```bash
npm run check   # tsc + eslint + prettier — all three must pass
```

If it fails, fix it. Do not suppress warnings or errors. Re-run until clean.

## Code Style Additions

Beyond what's in AGENTS.md:

- **Boolean expressions:** Avoid `!` operator except in `!=`. Use `if (value === false)` not `if (!value)`. Positive logic with if-else preferred.
- **Braces:** Always use `{}` for control structures, even single-line blocks.
- **Brevity:** Prefer ternary operators when readable. Minimize unnecessary variable assignments.
- **Error handling:** Throw descriptive errors with context. Don't swallow errors silently.
- **No unnecessary abstractions:** Three similar lines > premature helper function.

## Git Workflow

- Do not add `Co-Authored-By` lines to commit messages.
- Commit messages should be concise and describe the "why" not the "what".
- Push your work — work is not complete until `git push` succeeds.

## When Working on Core

The orchestrator and state machine are the heart of this project. When modifying `src/core/`:

- The state machine must remain deterministic — no randomness, no AI calls, no external service calls during state transitions.
- State transitions must be explicit and auditable.
- Keep the orchestrator simple. If a change adds significant complexity, reconsider the approach.

## When Adding Integrations

- Every integration implements `IssueTracker` or `SourceControl` interfaces.
- Never import integration-specific code in `src/core/`.
- Adapters are self-contained — all API calls, auth, and data mapping live inside the adapter directory.

## When Working on Skills

- Skills are markdown prompt templates, not code.
- Each skill has a single focused purpose.
- Skills communicate through structured handoff summaries, not shared state.
