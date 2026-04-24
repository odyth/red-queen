# Coding Standards — Node.js / TypeScript

These are the conventions the coder skill must follow. Edit freely —
especially the sections marked with TODO — to match your project.

## Formatting

- 2-space indentation, no tabs
- Double quotes for strings (match Prettier / ESLint config)
- Always use semicolons
- Trailing commas on multi-line literals
- 100-character line width
- LF line endings only

## TypeScript

- `"strict": true` is mandatory. No implicit `any`, no unchecked nulls.
- Prefer `interface` for public shapes, `type` for unions / primitives / intersections.
- No `any`. Use `unknown` when you truly do not know the shape, and narrow via
  type guards.
- Use `readonly` for fields that never mutate after construction.
- Avoid `as` type assertions outside of test fixtures and JSON parse boundaries.
- Named exports only (no default exports), so rename refactors are safe.

## Async

- Always `async/await`, never raw `.then()` chains except for short adapters.
- Use `Promise.all` for independent concurrent work; `Promise.allSettled` when
  partial failure is acceptable.
- Every `await` inside a `for` loop is suspect — prefer mapping + `Promise.all`.
- Never swallow rejections silently; re-throw or log with context.

## Errors

- Throw `Error` subclasses with descriptive messages that include the operation
  and offending value.
- Do not throw raw strings or primitives.
- At system boundaries (HTTP handlers, CLI entry points, worker dispatch),
  catch unknown, narrow to `Error`, log, and translate to the user-facing error.
- Do not catch and re-throw without adding context.

## Imports

- Node built-ins: `node:fs`, `node:path`, etc. with the explicit `node:` prefix.
- Project imports with relative paths. Always `.js` extension in source
  (even when the file is `.ts`) — NodeNext module resolution requires it.
- External packages after Node built-ins, project imports last.

## Testing

- Use Vitest (or Jest if the project already uses it).
- One `describe` block per function / class under test.
- Assert one behavior per `it` — easier to diagnose failures.
- Prefer table-driven tests (`it.each`) for pure functions with multiple cases.
- Use real dependencies (filesystem, in-memory SQLite) for integration tests
  over mocks whenever feasible — mocks drift.

## Don't

- Do not introduce new production dependencies without listing the reason in
  the PR description. Prefer Node built-ins.
- Do not use `eval`, `Function()`, or dynamic `require`.
- Do not commit `console.log` calls. Use the project's logger or the
  orchestrator's audit log.
- Do not bypass TypeScript errors with `// @ts-ignore` — fix the underlying
  issue, or use `// @ts-expect-error` with a comment if truly required.
