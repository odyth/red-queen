# Coding Standards — Rust

These are the conventions the coder skill must follow. Edit to match your
project's setup.

## Formatting

- `cargo fmt` — CI should fail on unformatted code.
- `cargo clippy -- -D warnings` — treat clippy lints as errors.

## Error Handling

- Return `Result<T, E>` from fallible functions. Reserve `panic!` for programmer
  bugs (invariant violations), not runtime failures.
- Do NOT use `.unwrap()` or `.expect()` in library code. They are acceptable in
  tests and in the `main` function of a binary after logging.
- Use `thiserror` for library error types, `anyhow` for binary / top-level
  error plumbing — consistency with ecosystem convention.
- Wrap errors with context using `.context("...")` (anyhow) or `#[from]` /
  `#[source]` (thiserror).

## Ownership

- Borrow by default. Take `&T` / `&mut T` unless the function needs ownership.
- Prefer `&str` over `String` in arguments; let the caller own the allocation.
- Use `Cow<'a, T>` when a function conditionally clones.
- Lifetimes: name them meaningfully (`'a` for the shortest-lived input when
  multiple are involved).

## Async

- Use `tokio` or the runtime already in the project. Do not mix runtimes.
- Every `.await` point should be documented with a comment if the blocking
  semantics are non-obvious.
- `#[tokio::main]` belongs in `main.rs`. Library code must be runtime-agnostic
  where possible.

## Testing

- `#[cfg(test)] mod tests { ... }` at the bottom of each module.
- Integration tests in `tests/` for public API.
- Use `assert_eq!` / `assert!` with descriptive messages.
- `proptest` or `quickcheck` for property-based tests where invariants apply.
- `#[should_panic(expected = "...")]` when asserting a panic.

## Style

- Prefer `if let Some(x) = ...` over `.unwrap_or_default()` when the absence
  case has meaningful behavior.
- Prefer iterator chains (`.map()`, `.filter()`, `.collect()`) over index loops
  for clarity.
- Derive traits (`Clone`, `Debug`, `PartialEq`) when they make sense, not
  reflexively.
- Document every public item with `///` doc comments. Run `cargo doc` to
  verify links.

## Don't

- Do not use `unsafe` without a comment block explaining the invariant.
- Do not hold `MutexGuard` across `.await` — use `tokio::sync::Mutex`.
- Do not use `Box<dyn Error>` in public APIs unless unavoidable — prefer
  a concrete error enum.
- Do not `#[allow(dead_code)]` on non-test code; delete the unused item instead.
