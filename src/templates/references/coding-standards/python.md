# Coding Standards — Python

These are the conventions the coder skill must follow. Edit freely to match
your project's setup.

## Formatting and Style

- PEP 8 compliant. Use `ruff` / `black` if configured.
- 4-space indentation.
- 88- or 100-character line width (match existing).
- Double quotes for strings (consistency with Black default).
- Two blank lines between top-level defs, one blank line between methods.

## Type Hints

- Public functions and class methods must have full type annotations on args
  and return value.
- Use `typing` / `collections.abc` imports (`Sequence`, `Mapping`, `Callable`).
- Prefer `X | None` over `Optional[X]` (Python 3.10+).
- Use `TypedDict` or dataclasses for structured dicts — do not pass bare dicts
  between layers.
- Run `mypy --strict` or `pyright` in CI; treat type errors as failures.

## Exceptions

- Raise specific exception classes, not bare `Exception`.
- Never write `except:` or `except Exception:` without re-raising or logging
  with context. Narrow catches to the specific failure modes you handle.
- Chain exceptions with `raise X("...") from e` to preserve traces.
- Do not use exceptions for control flow (outside of iterators / optional paths).

## Imports

- Standard library first, third-party second, local last. One blank line
  between groups. `isort` enforces this.
- No wildcard imports.
- No relative imports across package boundaries — use explicit package paths.

## Testing

- `pytest` is the default. `unittest` is acceptable if the project uses it.
- Use `pytest.fixture` over setUp/tearDown.
- Parametrize tests with `@pytest.mark.parametrize` for multi-case coverage.
- Assert one behavior per test where practical.
- Do not mock the filesystem or SQLite for integration tests — use `tmp_path`
  and an in-memory database instead.

## Async

- `async def` functions must be awaited or wrapped in `asyncio.create_task`.
  Forgotten awaits are silent bugs.
- Use `asyncio.gather(*tasks)` for concurrent work, `asyncio.as_completed` for
  streaming results.
- Do not mix blocking I/O (e.g., `requests`, bare `open()` in hot paths) with
  async code — use `aiohttp` / `aiofiles` / `asyncio.to_thread`.

## Don't

- Do not commit `print()` calls outside CLI entry points. Use `logging` with
  a named logger per module.
- Do not catch `BaseException` / `KeyboardInterrupt` unless exiting.
- Do not use `pickle` with untrusted input.
- Do not swallow `AssertionError` — it indicates a bug, not a runtime condition.
