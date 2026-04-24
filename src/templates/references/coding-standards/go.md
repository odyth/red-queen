# Coding Standards — Go

These are the conventions the coder skill must follow. Edit to match your
project's setup.

## Formatting

- `gofmt` (or `goimports`) — non-negotiable. CI should fail on unformatted code.
- Tabs for indentation (Go default).
- Import groups: standard library, third-party, internal — separated by blank
  lines. `goimports` enforces this.

## Naming

- Exported identifiers start with a capital letter. Unexported lowercase.
- Package names: short, lowercase, no underscores. Match the directory name.
- Receiver names: one or two letters, consistent across methods on the same type.
- Interface names ending in `-er` (Reader, Writer) for single-method interfaces.

## Errors

- Every error return value must be checked. If you discard, explicitly use `_`.
- Wrap errors with `fmt.Errorf("doing X: %w", err)` so `errors.Is` / `errors.As`
  can traverse the chain.
- Use `errors.Is(err, sentinel)` for sentinel comparisons, `errors.As(err, &t)`
  for type assertions. Never use `err.Error() == "..."`.
- Do not `log.Fatal` inside library code — return errors. Fatal belongs in `main`.

## Concurrency

- Every goroutine must have a clear termination condition. No "fire and forget".
- Use `context.Context` as the first parameter of every exported function that
  may block, do I/O, or call something that does.
- Prefer channels for ownership transfer, `sync.Mutex` for shared mutable state.
- Do not spawn a goroutine inside a `defer` — surprising lifetime.

## Testing

- Table-driven tests (`tests := []struct{...}{...}` with `for _, tc := range tests`).
- Test function names: `TestSubject_Condition_Expected`.
- Use `t.Run(name, func(t *testing.T){...})` for subtests so `-run` filters work.
- Use `testing.TempDir()` for filesystem tests.
- Prefer `github.com/stretchr/testify` assertions only if already used in the
  project; otherwise stick with standard `t.Errorf` / `t.Fatalf`.

## Style

- Keep functions small. Extract when a function spans more than a screen.
- Prefer early returns over nested `if`. Guard clauses at the top.
- Document every exported identifier with a sentence starting with its name:
  `// Foo does X.` — `go doc` parses this.

## Don't

- Do not use `panic` for recoverable errors. Reserve for programmer bugs.
- Do not init global state with `init()` unless absolutely required.
- Do not use `interface{}` / `any` without justification — most of the time
  a concrete type or generics are clearer.
- Do not import `C` unless the PR explains why cgo is required.
