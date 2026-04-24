# Review Checklist — Web API

This checklist runs during the code-review phase. A ✅ / ❌ on each category
feeds into the reviewer's verdict. Adapt to your stack.

## Blockers (must pass to merge)

### Security

- [ ] **Input validation:** every request field is validated (length, type,
      format). No trust-the-client patterns.
- [ ] **Authentication:** protected endpoints check identity. No public
      endpoints accidentally added.
- [ ] **Authorization:** checks whether the authenticated user is allowed to
      touch the resource. Horizontal privilege escalation prevented.
- [ ] **SQL injection:** parameterized queries or ORM. No string concatenation
      into SQL.
- [ ] **XSS / injection:** user-controlled strings in HTML / SQL / shell are
      properly encoded / escaped.
- [ ] **Secrets:** no API keys, passwords, or tokens in code, tests, or logs.
- [ ] **CORS / CSRF:** origin checks or token defenses where applicable.
- [ ] **Rate limiting / input size limits:** no unbounded loops over untrusted
      input, no unbounded request bodies.
- [ ] **Sensitive data in logs:** PII / credentials / tokens are not logged.

### Correctness

- [ ] **Acceptance criteria:** every criterion in the spec is met.
- [ ] **Error paths:** 4xx vs 5xx distinction is correct. Client errors do not
      page oncall.
- [ ] **Transactions:** multi-step writes are atomic (DB transaction or
      compensating action).
- [ ] **Idempotency:** POSTs that may be retried have idempotency keys or
      natural dedup keys.
- [ ] **Null / empty handling:** boundary conditions documented in the spec
      are covered.

### Observability

- [ ] **Logging:** the change emits enough logs to diagnose a failure in
      production without attaching a debugger.
- [ ] **Metrics:** counters for success / failure, latencies for new slow
      paths. Not always required, but consider.

## Warnings (address if easy, note if not)

### Performance

- [ ] No N+1 queries where a single join would do.
- [ ] Pagination on endpoints that return collections.
- [ ] Async I/O for anything that blocks on the network or filesystem.
- [ ] No unnecessary re-computation inside hot loops.

### Maintainability

- [ ] Naming: functions and variables read clearly.
- [ ] Scope: the change matches what the spec described. No scope creep.
- [ ] Tests: new code paths have tests. Existing tests still pass.
- [ ] Duplication: no copy-pasted logic that should be shared.

### Documentation

- [ ] OpenAPI / schema updated if the public API changed.
- [ ] Inline comments explain **why** where the code's intent is non-obvious;
      deleted where the code made them redundant.
