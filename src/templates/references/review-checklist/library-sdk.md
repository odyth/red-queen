# Review Checklist — Library / SDK

This checklist runs during the code-review phase for code that other projects
will depend on. Downstream breakage is expensive — err on strict.

## Blockers (must pass to merge)

### API Stability

- [ ] **Semver respected:** no breaking changes without a major version bump.
      Renames, removed exports, changed signatures, stricter types, new
      required params all count as breaking.
- [ ] **Deprecations:** removed APIs were deprecated in a previous minor
      release with a migration path documented.
- [ ] **Public surface:** every new export has a clear purpose. No accidental
      exports.

### Correctness

- [ ] **Acceptance criteria:** the spec's requirements are met.
- [ ] **Edge cases:** empty inputs, null, very large inputs, Unicode, time
      zones, locales.
- [ ] **Concurrency:** documented thread-safety holds. Mutable shared state
      is justified.
- [ ] **Resource cleanup:** everything opened (files, sockets, locks,
      subscriptions) is released on both success and error paths.

### Types

- [ ] **Strictness:** no `any` / `interface{}` / untyped parameters in public
      APIs without justification.
- [ ] **Generics:** used where they add clarity, avoided where they add
      cognitive load.
- [ ] **Return types:** consistent across similar methods. Promises always
      return typed values.

### Dependencies

- [ ] **No new deps** unless the PR description explains why a built-in
      doesn't suffice.
- [ ] **Existing deps** stay on current major versions unless the PR is a
      deliberate upgrade.
- [ ] **Peer deps** declared correctly if applicable.

## Warnings (address if easy)

### Documentation

- [ ] Every exported function / class / type has a doc comment with a usage
      example.
- [ ] README updated if the public API or setup changed.
- [ ] CHANGELOG entry with the version bump and migration notes.

### Testing

- [ ] Public API has direct tests (not just through integration).
- [ ] Error paths have tests. Happy path alone is not enough.
- [ ] Edge cases (empty, null, Unicode) tested where applicable.
- [ ] If the library has multiple runtimes (Node + browser, native + WASM),
      each has CI coverage.

### Maintainability

- [ ] No copy-pasted logic across files that should share a helper.
- [ ] Performance characteristics documented where non-obvious (time /
      space complexity, I/O patterns).
- [ ] Examples in documentation compile and run.
