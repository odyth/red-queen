# Review Checklist (TODO)

Fill in the categories that matter for your project. The reviewer skill uses
this to produce the review report — the more specific your items, the more
actionable the feedback.

Mark items as **BLOCKER** (must pass to merge) or **WARNING** (note, don't
block). Everything else is context.

## Blockers

### Correctness

- [ ] TODO: acceptance criteria met
- [ ] TODO: error paths covered

### Security

- [ ] TODO: input validation
- [ ] TODO: auth / authz checks
- [ ] TODO: secrets not leaked

### Tests

- [ ] TODO: new code paths have tests
- [ ] TODO: existing tests still pass
- [ ] TODO: CI is green (or failures are pre-existing)

## Warnings

### Performance

- [ ] TODO: no obvious N+1, pagination on unbounded queries

### Maintainability

- [ ] TODO: naming is clear
- [ ] TODO: scope matches the spec
- [ ] TODO: no duplication

### Documentation

- [ ] TODO: public API changes documented
- [ ] TODO: non-obvious code is commented for intent, not mechanics
