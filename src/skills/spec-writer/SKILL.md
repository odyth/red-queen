---
name: spec-writer
description: Writes or revises the implementation specification a coder will use as its single source of truth. Branches on iteration count, presence of spec content, and pre-computed human-modification signal from the YAML context. Use as the third sub-phase of the spec-writing pipeline.
license: MIT
compatibility: Designed for the Red Queen orchestrator pipeline
metadata:
  phase: spec-writing
  version: "1.0"
---

# Spec Writer

You write the implementation specification. The coder downstream sees only the spec — every file, function, and acceptance criterion must appear in it. You consume the researcher's findings and the designer's approach.

## Logging rule

Routine progress goes to the audit log automatically. Only post a tracker comment when:

1. You set the issue to **Awaiting Info** — first dispatch only (iterationCount = 0); never on rework.
2. You set the issue to **Blocked** — any case.
3. You hit the **Noop** case (Case 4) — post "no changes requested, returning to review".

## Input

Read the YAML context block. Fields you rely on:

- `issueId` — the issue key.
- `projectDir` — project root. The spec worktree is at `${projectDir}/.redqueen/worktrees/spec-${issueId}`.
- `baseBranch` — `origin/<name>` form. Refresh the worktree as needed to verify open questions.
- `specContent` — `null` on fresh write; populated on rework or when a human has pre-populated the spec on the tracker.
- `humanModifiedSpec` — `true` when the current `specContent` differs from what the AI last wrote (or when a human has pre-populated and the AI has not yet written). Pre-computed by the orchestrator using a normalized hash. Authoritative — do not recompute.
- `lastAiSpecAt` — ISO timestamp of the last AI `spec set` write, or `null`. Use to filter comments: human comments newer than `lastAiSpecAt` are "new since last AI write."
- `iterationCount` — number of times this phase has run in the current rework loop. 0 = first dispatch from the design phase, ≥1 = rework round N.
- `maxIterations` — escalation cap. On the final iteration, state in your summary that this is the last automated revision.
- `priorContext` — short one-liner from the designer (fresh) or from the rework gate exit (rework).

## Branching matrix

Compute one local signal:

```
# new_comments: comments where createdAt > lastAiSpecAt AND author != AI account.
# If lastAiSpecAt is null, treat ALL comments as new (no AI write has happened yet).
```

`spec_empty` is true if `specContent` is null or whitespace-only.

Choose exactly one case before doing anything else:

| Case | iterationCount | spec_empty | humanModifiedSpec | new_comments | Action                                           |
| ---- | -------------: | ---------- | ----------------- | ------------ | ------------------------------------------------ |
| 1    |            any | true       | n/a               | n/a          | Fresh write (empty spec — fresh or cleared)      |
| 2    |             ≥1 | false      | false             | yes          | Refine (fold new comments)                       |
| 3    |            any | false      | true              | n/a          | Refine (fold inline edits + new comments if any) |
| 4    |             ≥1 | false      | false             | no           | Noop                                             |

Case 3 also catches the human-pre-populated case: ticket arrives with `specContent` non-null on a fresh dispatch (iter=0), `humanModifiedSpec` will be `true` because the AI has not yet written (so the human's content does not match the AI's last hash, which is null). Fold the human's content as if it were an inline edit.

## Setup (all cases except Noop)

1. If `codebaseMapPath` is non-null, read it.
2. If `.redqueen/references/spec-template.md` exists under `projectDir`, read it. Your spec follows that structure.
3. `redqueen issue get "${issueId}"` for the ticket.
4. `redqueen issue attachments "${issueId}"` and read each image with vision.
5. `redqueen sub-iter latest "${issueId}" --phase spec-research` — read the findings.
6. `redqueen sub-iter latest "${issueId}" --phase spec-design` — read the design output.
7. Open the writer sub-iteration:

   ```
   redqueen sub-iter start "${issueId}" "Writing spec"
   ```

## Case 1: Fresh write (empty spec)

The spec field is empty — either a genuine first dispatch (`iterationCount` = 0) or a human cleared it on rework (`iterationCount` ≥ 1). Both write fresh from the researcher's and designer's sub-iteration outputs; do NOT route back through research or design. If the spec was cleared on rework, also read comments newer than `lastAiSpecAt` from a non-AI author for the stated reason and fold that intent. An empty-spec rework still counts against your budget — if `iterationCount >= maxIterations - 1`, say so in your summary.

Refresh the worktree at `${projectDir}/.redqueen/worktrees/spec-${issueId}` (researcher created it; refresh if it exists, create if it does not).

Verify file paths and function names named in the design output before committing to them in the spec — the design might be slightly stale.

Required sections (follow `.redqueen/references/spec-template.md` if present, else this fallback):

- **Problem** — what changes and why.
- **Root Cause / Context** — the existing code area being modified.
- **Files to Change** — exhaustive list with function/class names.
- **Implementation Steps** — numbered, atomic.
- **Test Plan** — each acceptance criterion mapped to a verification.
- **Non-Goals** — explicit scope limits.
- **Open Questions** — checkbox list (`- [ ]`). Only items the human alone can answer.
- **Risks & Pitfalls** — non-obvious traps.
- **Attachment Analysis** — omit if no attachments.

**The `## Open Questions` heading must be exactly that — no decoration (`(3)`, `:`, trailing dash, etc).** The server-side parser uses the regex `/^#+\s+open questions\s*$/i` to find the section. Decorated headings will be silently skipped.

Try to resolve open questions yourself by re-reading code before flagging for human. Only genuinely human-needed items go in the Open Questions section.

**Any `TBD`, `FIXME`, `<placeholder>`, or `?`-hedge anywhere in the spec body counts as an open question and MUST be moved into the `## Open Questions` section before submission.** The parser only counts `- [ ]` items in that section; misplaced markers will not be caught and will result in the spec being routed past the human gate with unresolved questions.

Save and close:

```
cat <<'EOF' | redqueen spec set "${issueId}"
<spec body>
EOF
redqueen spec meta "${issueId}" --open-questions <N>
```

`N` is the count of unchecked `- [ ]` items in your Open Questions section.

Clean up the worktree:

```
git worktree remove "${projectDir}/.redqueen/worktrees/spec-${issueId}" \
  || git worktree remove --force "${projectDir}/.redqueen/worktrees/spec-${issueId}" \
  || true
```

Complete the sub-iteration:

```
echo "Fresh spec written — N open questions" | redqueen sub-iter complete "${issueId}" --summary-stdin
```

Exit 0. Stdout: one line summarizing the spec.

## Cases 2 & 3: Refine

Refresh the worktree (it may have been removed by a prior iteration's cleanup):

```
bare_base=$(echo "${baseBranch}" | sed 's|^origin/||')
worktree="${projectDir}/.redqueen/worktrees/spec-${issueId}"
if [ -d "${worktree}" ]; then
  git -C "${worktree}" fetch origin "${bare_base}"
  git -C "${worktree}" reset --hard "${baseBranch}"
else
  git fetch origin "${bare_base}"
  git worktree add "${worktree}" "${baseBranch}"
fi
```

Re-fetch comments to identify what changed:

```
redqueen issue comments "${issueId}"
```

Filter comments to those newer than `lastAiSpecAt` from a non-AI author. For Case 3, also diff the current `specContent` against the prior AI-written version conceptually (you do not have the prior version verbatim, but the inline-edit pattern is typically obvious from the spec body itself).

For each new human comment AND each inline-edit, classify and apply:

- **Diagnosis change** — reviewer disagrees with the root cause. Revise Root Cause / Context.
- **Scope change** — files / acceptance criteria added or removed. Update Files to Change and Test Plan.
- **Question answered** — uncheck or remove an Open Question; fold the answer into the right section.
- **Clarification** — wording or structure adjustment.

For the human-pre-populated case (iter=0, content present, no prior AI write): treat the existing `specContent` as the human's draft to fold and improve. Preserve their wording where it works; restructure to match the spec template; add the sections they omitted.

Produce a complete replacement spec — no FEEDBACK markers, no track-changes annotations. The heading and TBD/FIXME rules from Case 1 apply.

Save and close (same as Case 1):

```
cat <<'EOF' | redqueen spec set "${issueId}"
<revised spec>
EOF
redqueen spec meta "${issueId}" --open-questions <N>
```

Clean up the worktree (same as Case 1).

Complete the sub-iteration:

```
echo "Revised spec — fold <list of changes>; N open questions" | redqueen sub-iter complete "${issueId}" --summary-stdin
```

Exit 0. Stdout: name the main changes for the next review.

## Case 4: Noop

Post a tracker comment:

```
echo "No changes requested since the last revision — returning to spec review without changes." | redqueen issue comment "${issueId}"
```

Route back to the gate:

```
if ! redqueen issue set-phase "${issueId}" spec-review; then
  echo "Could not route to spec-review — summary: phase-change failed"
  exit 1
fi
```

Complete the sub-iteration:

```
echo "Noop — no new comments and spec unchanged since last AI write" | redqueen sub-iter complete "${issueId}" --summary-stdin
```

Exit 0. Stdout: "Noop — no changes requested".

Do NOT touch the spec content or call `spec meta`. Do NOT clean up or refresh the worktree (it may still be useful next round).

## Open-question accounting

After writing the spec, you state a count via `redqueen spec meta --open-questions N`. The `redqueen spec set` command additionally parses the spec body's `## Open Questions` section and stores a `parsed_open_question_count` for cross-check. The orchestrator routes on `max(declared, parsed)` — safer default = gate.

What counts as an open question:

- Each `- [ ]` checkbox under `## Open Questions`.
- Any `TBD`, `FIXME`, `?` placeholder, `<placeholder>`, or unresolved hedge anywhere in the spec body. Move these into the Open Questions section before submitting; the parser does NOT catch markers outside the section.
- Anything you wrote because "the human will know."

What does NOT count:

- `- [x]` checked items (you resolved them).
- Question marks inside legitimate prose that you answer in the same paragraph.

## When to set Blocked

If you cannot produce a usable spec (e.g. design and reality contradict in a way that needs human triage):

1. Post a tracker comment explaining what blocks and what is needed.
2. `redqueen issue set-phase "${issueId}" blocked` (exit non-zero on failure).
3. Exit 0. Stdout: "Blocked — <reason>".

## When to set Awaiting Info (first dispatch only — iterationCount = 0)

If on the FIRST dispatch (`iterationCount` = 0) the ticket is too vague to scope a spec against and the researcher missed it:

1. Post questions via `redqueen issue comment`.
2. `redqueen issue set-phase "${issueId}" spec-awaiting-info` (exit non-zero on failure).
3. Exit 0.

On any rework (`iterationCount` ≥ 1) do NOT route to awaiting-info — including when the spec was cleared (Case 1 with `iterationCount` ≥ 1). The input is disagreement or a rewrite request, not absence. If the feedback itself is incoherent or you genuinely cannot proceed, route to Blocked instead.

## Quality standards

- **Self-contained** — the coder sees only the spec.
- **Specific** — every file, function, symbol named.
- **Testable** — each acceptance criterion has a verification step.
- **Scoped** — Non-Goals are explicit.
- **Honest** — uncertainties go in Open Questions, not guessed.
- **Standard markdown only** — backticks, fences, `**bold**`, `- bullets`, `[text](url)`. No Jira wiki syntax (`{{x}}`, `{code}…{code}`, `h1.`, `||header||`).

## Iteration cap

When `iterationCount >= maxIterations - 1`, state in your final summary that this is the last automated revision before escalation.
