# Coding Standards — .NET / C#

These are the conventions the coder skill must follow. Edit to match your
project's setup.

## Formatting

- Match `.editorconfig` / Roslyn analyzers in the solution.
- 4-space indentation, no tabs.
- Allman braces (braces on their own line).
- One type per file, file name matches the type name.
- `using` directives sorted and grouped (System first, then project, then
  third-party).

## Naming

- `PascalCase` for types, methods, properties, public fields, constants.
- `camelCase` for private fields (with `_` prefix for backing fields).
- `camelCase` for local variables and parameters.
- Async methods end with `Async` (`LoadAsync`, not `Load`).
- Interface names start with `I` (`IRepository`).

## Nullable Reference Types

- `#nullable enable` at the project level. Fix or annotate every warning.
- Use `?` to mark nullable, `required` for required-at-construction properties.
- Avoid `!` (null-forgiving) — it masks real bugs. Prefer guards or pattern
  matching.
- Do not use `Nullable<T>` for reference types; the nullability annotation is
  sufficient.

## Async / Await

- Use `async` / `await` throughout; never `.Result` / `.Wait()` (deadlocks).
- `CancellationToken` as the last parameter of every async public method.
- Suffix: `LoadAsync(cancellationToken)`.
- Use `ConfigureAwait(false)` in library code; not needed in ASP.NET Core.
- Do not use `async void` except for event handlers.

## Exceptions

- Throw the most specific exception type that applies (`ArgumentNullException`,
  `InvalidOperationException`).
- Do not catch `Exception` unless re-throwing with context or logging and
  re-throwing.
- Use pattern matching in `catch` (`catch (HttpRequestException ex) when (...)`).
- Define custom exception types for domain errors; inherit from `Exception` and
  provide a standard constructor set.

## Collections

- Prefer `IReadOnlyList<T>` / `IReadOnlyDictionary<TK, TV>` for method returns.
- `LINQ` for readable transformations; materialize with `ToArray()` /
  `ToList()` at the boundary, not mid-pipeline.
- `IEnumerable<T>` in parameters when you only iterate once.

## Testing

- xUnit or NUnit (whichever the project uses). Match existing style.
- FluentAssertions for readable assertions.
- `[Theory]` with `[InlineData]` / `[MemberData]` for parameterized tests.
- Integration tests against a real SQL Server or SQLite in-memory — avoid
  mocking `DbContext`.

## Dependency Injection

- Constructor injection only. No property injection or service locator pattern.
- Register services in `Startup.cs` / `Program.cs`; keep registration
  centralized.
- Scoped by default; Singleton only for stateless helpers; Transient when
  explicitly required.

## Don't

- Do not use `dynamic` outside of COM / reflection scenarios.
- Do not `Task.Run` to wrap synchronous code in a web request — it harms
  throughput.
- Do not commit `Console.WriteLine` — use `ILogger<T>`.
- Do not use `#pragma warning disable` without a comment explaining why.
