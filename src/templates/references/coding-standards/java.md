# Coding Standards — Java / Kotlin

These are the conventions the coder skill must follow. Edit to match your
project's setup.

## Formatting

- Google Java Style or Oracle conventions, whichever the project uses.
- 4-space indentation.
- 100-column line width.
- One class per file (except for small private helpers).
- Imports: no wildcards, grouped and sorted.

## Naming

- `PascalCase` for classes / interfaces.
- `camelCase` for methods and variables.
- `SCREAMING_SNAKE_CASE` for constants (`static final`).
- Interface names are nouns, not adjectives (`Cache`, not `Cacheable`).
- Test classes end with `Test` (`FooTest`, not `TestFoo`).

## Types

- Prefer explicit types over `var` for public APIs. `var` is fine for local
  variables with obvious right-hand-side types.
- Use generics to express constraints; avoid raw types.
- Use `Optional<T>` for return values that may be absent — not for fields or
  parameters.
- Enable nullable annotations (`@Nullable` / `@NonNull`) if the project uses them.

## Exceptions

- Throw checked exceptions for recoverable conditions, unchecked for
  programmer bugs.
- Wrap lower-level exceptions in domain-specific exceptions; preserve the cause.
- Do not catch `Exception` or `Throwable` at arbitrary points — narrow to the
  specific types you handle.
- Do not swallow `InterruptedException` — restore the interrupt flag
  (`Thread.currentThread().interrupt()`) before continuing.

## Concurrency

- Prefer `java.util.concurrent` abstractions (`ExecutorService`, `CompletableFuture`)
  over raw threads.
- Immutable objects are the default; make mutable state explicit and justify it.
- Avoid `synchronized` when a lock-free alternative exists (`ConcurrentHashMap`,
  `AtomicInteger`).
- Document thread-safety of every public class.

## Testing

- JUnit 5 (`org.junit.jupiter`). JUnit 4 is acceptable if the project uses it.
- AssertJ fluent assertions are preferred over vanilla JUnit assertions when
  the project already depends on it.
- Mockito for mocks; prefer real objects when feasible.
- Parameterized tests (`@ParameterizedTest`) for table-driven scenarios.

## Kotlin (if applicable)

- Use `data class` for value types.
- Use `val` by default; `var` only when mutation is required.
- Prefer `when` over long `if/else` chains.
- `sealed class` / `sealed interface` for exhaustive pattern matching.
- Coroutines over threads; scope them to a lifecycle.

## Don't

- Do not commit commented-out code — delete it; `git` remembers.
- Do not call `System.exit()` outside `main`.
- Do not use reflection / setAccessible without a safety comment.
- Do not log at `ERROR` level for expected conditions (e.g., 404s).
