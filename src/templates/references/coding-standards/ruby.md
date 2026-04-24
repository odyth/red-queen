# Coding Standards — Ruby

These are the conventions the coder skill must follow. Edit to match your
project's setup.

## Formatting

- Rubocop or Standard style, whichever the project already uses.
- 2-space indentation, no tabs.
- Double quotes only when interpolation is used; single quotes otherwise.
- No trailing whitespace, newline at end of file.

## Style

- Prefer block form (`do ... end` for multi-line, `{ ... }` for single-line).
- Use `&.` safe navigation instead of explicit `nil` checks when appropriate.
- Prefer `each`, `map`, `select` over index-based iteration.
- Prefer keyword arguments for any method with more than two parameters.
- Avoid `for` loops — use `each` instead.

## Naming

- `snake_case` for methods and variables.
- `CamelCase` for classes and modules.
- `SCREAMING_SNAKE_CASE` for constants.
- Predicate methods end with `?`; bang methods end with `!`.

## Errors

- Raise `StandardError` subclasses, not bare `RuntimeError` or `Exception`.
- Define custom error classes for domain-specific failures.
- `rescue StandardError => e` rather than bare `rescue`.
- Never swallow exceptions silently — log with context and re-raise or handle.

## Testing

- RSpec preferred; minitest acceptable if already in the project.
- One expectation per `it` when practical.
- Use `let` and `subject` for shared setup, `before` for side-effect setup.
- Use `FactoryBot` (or equivalent) for test data, not inline hashes.
- Integration tests should hit the real database (with transactional fixtures),
  not mocks.

## Rails (if applicable)

- Fat models, skinny controllers — but extract to service objects when a model
  exceeds ~300 lines.
- Strong parameters on every controller action that accepts input.
- Scopes for reusable query logic, not inline `.where` chains scattered across
  callers.
- Background jobs (Sidekiq / ActiveJob) for anything that touches external
  services in a request path.
- Migrations must be reversible — implement `down` or use reversible-friendly
  operations.

## Don't

- Do not monkey-patch core classes without a `Ext` namespace and a comment
  explaining why.
- Do not use `send` / `public_send` with user-controlled input.
- Do not rescue `Exception` — it catches `SystemExit` and `Interrupt`.
- Do not use `eval` / `class_eval` with user input.
