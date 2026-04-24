# Implementation Spec Template

This template is what the prompt-writer skill produces. It is what the coder
skill reads as its single source of truth — the coder has no access to the
issue, comments, or exploration that produced the spec. Every file path,
method name, and acceptance criterion below must be concrete and verifiable.

## Problem

One paragraph on what needs to change and why. Describe the user-visible
effect or the business constraint being solved, not the implementation.

## Root Cause / Context

If this is a bug: the actual cause. If this is a feature: the existing code
area the change plugs into. Name files and functions. No hand-waving.

## Files to Change

Exhaustive list. One bullet per file. For each:

- `path/to/file.ext` — what changes and why
  - Functions/classes affected: names
  - Behavior before → after

## Implementation Steps

Numbered, sequential, atomic steps. Each step should be small enough to
verify independently.

1. ...
2. ...

## Test Plan

Every acceptance criterion must map to a verification method.

- Unit: which tests are added or updated, what they assert
- Integration / e2e: scenarios to cover
- Manual verification: steps a human can run

## Non-Goals

Explicitly list things that are out of scope. This prevents the coder from
expanding the change. Examples:

- Does not refactor `X`
- Does not touch public API signatures of `Y`
- Does not update docs in `Z` (separate ticket)

## Open Questions

Use checkboxes so the reviewer can mark them resolved during spec review.

- [ ] Assumption: <state the assumption>. Reviewer: confirm or correct.
- [ ] Question: <what is unclear>. Reviewer: please answer.

If there are no open questions, state "None".

## Risks & Pitfalls

Non-obvious things that could trip up the coder:

- Ordering dependencies between files
- Edge cases the existing code handles implicitly
- Integration boundaries where a wrong assumption would cause subtle bugs

## Attachment Analysis

If the issue has image or PDF attachments, describe what each one shows and
how it informs the implementation. The coder cannot see attachments — this
section is their only window into visual context.

If there are no attachments, omit this section.
