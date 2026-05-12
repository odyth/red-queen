# Red Queen v6 — Spec & Code Loop Redesign

> Captures the design conversation about overhauling the spec and code review
> loops. No implementation code. Read this before any implementation session;
> use it to anchor follow-up design conversations.

## Background

The current pipeline (post-`d91f088a`) added a `plan-review` phase between
`spec-writing` and `spec-review`. It rates the spec 1-10 and routes to
`spec-feedback` (prompt-writer rework) if blockers exist, looping up to 3
times before escalating.

In practice this loop produces churn without signal:

- The planning-review skill's report (with the specific blockers and
  required decisions) only exists in the model's working context. It is
  never piped to the next phase.
- The only thing persisted is the numeric verdict via
  `redqueen plan verdict` (verdict, rating, blockers, open-questions
  counts).
- `priorContext` carries a 500-char-truncated short summary line such as
  "Plan review failed — iteration 1/3, 3 blockers." No detail.
- The planning-review skill is explicitly told not to post a tracker
  comment except on Blocked routing.
- Result: when prompt-writer runs in `spec-feedback`, it has no
  actionable feedback. It revises the spec by guessing. Plan-review
  finds the same blockers. Three rounds, no progress, then escalates to
  the human anyway.

Investigation also surfaced that the code-review → coding loop has a
similar broken pipe but it's masked by GitHub PR state, the persistent
worktree, and the tester running build/test itself. The coder skill
contains no instructions to fetch PR reviews; "5/10 → 8/10" improvements
between rounds are likely a mix of (a) the model voluntarily running
`gh pr view`, (b) regression-to-the-mean on rating, (c) cosmetic changes
that look like improvement.

The "Alice" predecessor (AlignSmart) used a similar shape but had a few
differences that mattered:

- Phase-to-phase handoff was via Jira fields + GitHub PR + filesystem
  worktree. Worker summaries were truncated to 200 chars but **only for
  the orchestrator's audit log** — never passed forward.
- `reviewIterations` reset to 0 when the reviewer passed, allowing
  testing failures to re-enter the review loop with a fresh budget. Red
  Queen lost this behavior.
- Same gap in the coder skill: no explicit fetch of PR reviews.

The redesign captured here addresses these issues and several adjacent
ones (rating-driven gradient drift, missing "rework with no feedback"
noop handling, no observable in-skill sub-iteration progress).

## Architectural Principles

These are the through-lines underlying the specific decisions below:

1. **Skills emit short narration; durable feedback lives in
   side-channels.** PR threads (code review), PR comments (testing),
   tracker comments (human feedback), SQLite (in-skill iteration
   notes). `priorContext` is for "what just happened" diagnostics, not
   the data channel.
2. **The orchestrator owns routing decisions.** Skills exit with a
   success / failure signal and write structured metadata. The
   orchestrator reads that metadata and routes deterministically based
   on phase config + pipeline state. No AI decision-making in the
   state machine.
3. **Iteration count + previous phase ride in the YAML context
   block.** Skills branch on these values. No magic strings ("fresh"
   vs "rework"); iteration number is more expressive and supports
   N-step internal workflows.
4. **Reviewer and coder share the same code-style philosophy.** Both
   bind to project CLAUDE.md / coding-standards.md so the reviewer
   doesn't request defensive bloat the coder is told to avoid.
5. **Binary routing signals beat numeric ratings.** A 1-10 scale
   invites gradient-justification drift. "Has unresolved blocker
   threads / does not" is harder to game.

## Decisions Locked

1. **`plan-review` phase is removed entirely.** Surgically; don't
   revert the original commit since the database schema, CLI, and
   tests may have landed alongside other changes worth keeping.
2. **`spec-feedback` phase is removed entirely.** Its work folds into
   `spec-writing` via iteration-aware branching.
3. **Prompt-writer becomes multi-phase: research → design → write.**
   Three distinct orchestrator phases. Same skill running three times
   with a different `phaseName` (or `iterationCount`) each time. Not
   subagents, not one big context window — three explicit dispatches.
4. **`iterationCount` (and where applicable `phaseName`) in the YAML
   context block drive skill branching.** Replaces magic mode strings.
5. **`priorPhase: string | null` is added to the YAML context.** The
   orchestrator sets it when dispatching. Coder branches on it to
   choose the feedback source (PR threads vs test comments).
6. **Open question count is surfaced via a CLI metadata command.**
   Skill writes via `redqueen spec meta <issueId> --open-questions N`.
   Orchestrator reads from SQLite and routes on
   `open_questions === 0 && skipSpecReviewIfReady === true` →
   directly to coding; else to spec-review human gate.
7. **Reviewer uses inline PR review threads for blockers.** Each
   blocker is an inline thread anchored to `file:line`. Improvements
   are bullet-listed in the PR body (Approach 2 — channel
   separation).
8. **No PR review body summary unless there are improvements.** No
   summary required when blockers are inline-threaded.
9. **No 1-10 rating, anywhere.** The routing signal is "are there
   unresolved blocker threads?" Drop rating from reviewer and from
   the (now-removed) planning-review.
10. **Reviewer fetches existing threads before opening new ones.**
    For each issue found, match against existing threads. Dedup
    unresolved threads. For regressed issues (was resolved, now
    broken again), open a new thread referencing the original. Do
    not try to programmatically unresolve threads.
11. **Coder pushback calibration: apply real fixes; push back on
    defensive bloat / hypothetical-future abstractions / style
    disagreements; never delete threads.** Reply with reasoning and
    resolve.
12. **Truncation cap raised from 500 → 2000 chars.** Applies to both
    `SUMMARY_MAX_LEN` and `ERROR_MAX_LEN`. `priorContext` stays as a
    narration channel, not the data channel.
13. **Testing posts results to PR as a structured comment.** Each
    run appends a new comment (does not edit prior ones). Coder on
    rework after testing fetches the most recent test comment.
14. **`review_exhausted` flag on `pipeline_state`.** Set true when
    `code-review` exceeds `maxIterations`. Used by orchestrator's
    failure handler for the final-test carve-out.
15. **Final-test carve-out: `code-review.escalateTo` becomes
    `testing` (not `human-review`).** When review maxes out, code
    gets one final test before human escalation. Testing's failure
    after `review_exhausted === true` routes to `human-review`
    without retrying coding.
16. **`review_iterations` resets to 0 when code-review passes.**
    Restores Alice-parity behavior; preserves the existing reset on
    human-gate-leave.
17. **`phase_sub_iterations` SQLite table tracks in-skill progress
    for the dashboard.** Skills write start/complete events via a
    new CLI. Dashboard renders alongside the Jira-visible phase.
18. **The rework path from spec-review human gate points to
    `spec-writing`** (which now subsumes spec-feedback). Single
    transition target; the skill's iteration logic handles
    "wholesale rewrite" vs "refine" via iteration count + presence
    of spec content.
19. **Wholesale-rewrite semantics:** `iter 0` AND spec content is
    present → treat as rewrite (refine existing). Spec content
    cleared by the human + sent back through → fresh write (the
    skill detects empty spec and starts over). No separate restart
    phase or CLI.
20. **Rework with no feedback = noop.** When the rework path fires
    but the skill finds no new tracker comments and no spec edits,
    skill posts back "no changes requested, returning to review"
    and returns to the human gate.

## HOW Each Mechanism Works

### A. Multi-phase prompt-writer

The single `spec-writing` phase is replaced by three explicit
orchestrator phases that each dispatch a flavor of the prompt-writer
skill. Each dispatch is its own worker process and its own context
window.

**Phase 1 — Research (`spec-research`):**

- Skill is dispatched with `iterationCount: 0`, `phaseName: spec-research`.
- Reads the ticket, explores the worktree (or main project tree)
  scoped to areas the ticket touches.
- Names the relevant files, functions, existing patterns, test
  files, and dependencies.
- Writes structured findings to SQLite via the sub-iteration CLI.
  Output is concise — focused on what the ticket touches, not the
  whole codebase.
- Dashboard label: "Codebase research."
- Exits successfully; orchestrator advances to `spec-design`.

**Phase 2 — Design (`spec-design`):**

- Skill is dispatched with `phaseName: spec-design`.
- Reads ticket + research findings (from SQLite) + tracker
  attachments.
- Sketches the implementation approach. Names key decisions.
  Identifies open questions.
- Does **not** write the spec yet.
- Writes design output to SQLite via the sub-iteration CLI.
- Dashboard label: "Solution design."
- Exits successfully; orchestrator advances to `spec-writing`.

**Phase 3 — Write (`spec-writing`):**

- Skill is dispatched with `phaseName: spec-writing`,
  `iterationCount: 0` on first pass.
- Reads ticket + research + design output.
- Writes the spec. Tries to resolve open questions itself by
  re-reading code or running focused verification. Only genuinely
  human-needed questions remain in the spec's Open Questions
  section.
- Saves spec to tracker (custom field) and `pipeline_state.spec_content`.
- Calls `redqueen spec meta <issueId> --open-questions N` with the
  count of remaining open questions.
- Dashboard label: "Writing spec."
- On success, orchestrator routes based on the open-question count
  + `skipSpecReviewIfReady` setting (see mechanism C).

**On rework (after spec-review human gate kicks back):**

- Orchestrator dispatches `spec-writing` again with
  `iterationCount: 1` (or higher on subsequent rounds).
- Skill branches on the rework path:
  - If spec content is present and iter > 0 → refine existing spec
    against the new tracker comments and inline edits.
  - If spec content is empty (human deleted it) → fresh write,
    optionally re-running research/design internally as the skill
    decides.
  - If no new tracker comments and spec is unchanged from last
    AI-generated version → post "no changes requested, returning
    to review" and return to the human gate.

**Dispatch flow for rework:** the human-gate rework target points
to `spec-writing`. The orchestrator increments
`feedback_iterations` on each rework dispatch (capped by
`maxIterations`, default 3). If feedback iterations exceed max, the
orchestrator escalates to the configured `escalateTo` (typically
`blocked` for spec-side issues that won't converge).

### B. Iteration-aware skills

The YAML context block gets two new fields:

- `iterationCount: number` — how many times this phase has been
  dispatched in the current automated stretch. Resets when leaving a
  human gate.
- `priorPhase: string | null` — the previous phase, set by the
  orchestrator when dispatching. Used by the coder to choose its
  feedback source.

Skills branch on these values explicitly. No magic mode strings.

Counter reset rules:

- All iteration counters (`review_iterations`, `feedback_iterations`)
  reset to 0 when the issue leaves a human gate. Existing behavior;
  preserved.
- `review_iterations` additionally resets to 0 when code-review
  passes (restores Alice parity). This allows a subsequent testing
  failure to re-enter the review loop with fresh budget.

### C. Open-question metadata

After the writing phase completes, the orchestrator needs to decide
whether to skip the spec-review human gate or not. The signal:
"does the spec have zero open questions, and is the user opted in
to skipping?"

The skill surfaces the count via CLI, not via stdout parsing:

```
redqueen spec meta <issueId> --open-questions 0 [--files-affected 3]
```

This writes to a SQLite column on `pipeline_state` (or a new
`spec_metadata` table). The orchestrator reads the column when
deciding the post-spec-writing transition:

- `open_questions === 0 && skipSpecReviewIfReady === true` →
  advance to `coding`.
- Otherwise → advance to `spec-review` human gate.

This mirrors the (now-removed) plan-verdict pattern at a smaller
scale.

### D. Inline review threads (Copilot-style)

The reviewer skill changes from "post one big review with a rating"
to "post inline review threads for blockers + bullet improvements
in the PR body."

Operational behavior:

1. Fetch existing threads via `redqueen pr comments <prNumber>
   --threads --include-resolved`. The reviewer needs to see both
   unresolved and resolved threads for the dedup logic.
2. Fetch the full PR diff (`redqueen pr diff <prNumber>`).
3. Run the review categories (correctness, security, performance,
   maintainability, spec compliance, style) against the whole diff.
4. For each issue found, classify as **blocker** or **improvement**
   and match against existing threads:
   - Match against unresolved thread (same file + nearby line,
     same issue) → skip, optionally post "still seeing this in
     latest commit" reply if it's a multi-round case.
   - Match against resolved thread where the coder pushed back with
     reasoning → **respect the pushback.** Treat as decided. Do not
     re-flag unless new code changes the context.
   - Match against resolved thread where the issue regressed (code
     was fixed and is broken again) → open a new thread referencing
     the original by URL.
   - No match → open new thread.
5. Blockers → posted as inline review thread comments anchored to
   `file:line` (mark as blocker in the thread body — see
   calibration notes).
6. Improvements → bullet-listed in the PR review body.
7. Exit non-zero when blocker threads exist, exit zero otherwise.
   This is explicit in the SKILL.md so orchestrator routing is
   deterministic.
8. The orchestrator routes on `count of unresolved blocker threads`,
   not on rating, count totals, or anything else.

No 1-10 rating, anywhere. Binary signal only.

### E. Coder rework mode

The coder skill branches on `priorPhase`:

- `priorPhase === null` (fresh dispatch from spec-writing) →
  existing fresh-write flow. Read spec, create or refresh worktree,
  implement, build, test, commit, push, open PR.
- `priorPhase === "code-review"` (rework after blocker threads) →
  - Fetch unresolved PR threads via `redqueen pr comments
    <prNumber> --threads`.
  - Also fetch the PR body for the improvements list.
  - For each blocker thread: read, decide validity, fix code OR
    push back with reasoning. Reply with "Done — <what changed>"
    or "Disagree because <reason>". Resolve the thread. Never
    delete.
  - For each improvement: apply if quick and clearly good, skip
    otherwise (these are explicit non-blockers).
  - Build, test, commit, push.
- `priorPhase === "testing"` (rework after build/test failure) →
  - Fetch the most recent test results comment from the PR
    (testing has posted it; see mechanism F).
  - Reproduce the failure locally in the worktree if not obvious
    from the comment.
  - Fix code, build, test, commit, push.

Pushback calibration is in the skill prompt (see calibration notes
section).

### F. Testing publishes results to PR

The tester skill now posts its results as a structured PR comment.
Behavior:

- After running build, targeted tests, full tests, and reading CI
  status, the tester composes a comment with all outcomes.
- Comment body has a clearly-parseable header like
  `## Test Results — <ISO timestamp>` so the coder can grep for
  the latest one.
- Each run appends a **new** comment; never edits prior ones.
  Keeps history readable. The "most recent" one is the source of
  truth on rework.

CI status, build pass/fail, targeted test pass/fail with counts,
full test pass/fail with counts, and a brief failure summary if
applicable. The coder uses this on rework to know what to fix.

### G. Final-test carve-out

When `code-review` exceeds `maxIterations` (default 3), the
orchestrator transitions to `testing` (the new `escalateTo`)
instead of going straight to `human-review`. The intent: give the
code one final round of actual functional testing before
escalating, because a nit-picky reviewer might be blocking code
that works fine.

State machinery:

- Orchestrator adds `review_exhausted` boolean column to
  `pipeline_state`. Set true when `code-review.escalateTo` is
  triggered. Cleared on gate-leave alongside iteration counters.
- Testing runs once more. Posts results to PR as usual.
- Testing's failure handler in the orchestrator checks
  `review_exhausted`:
  - `review_exhausted === true` → route to `human-review`
    (terminal — don't retry coding).
  - `review_exhausted === false` → route to `coding` per normal
    `onFail` semantics.
- Testing pass-through to `human-review` happens normally
  regardless of the flag.

Result: when review maxes out, the PR carries the latest review
threads (unresolved blockers from the final review pass) plus the
final test results. The human reviewer sees both signals and makes
the call.

### H. Truncation cap

`SUMMARY_MAX_LEN` and `ERROR_MAX_LEN` (worker.ts) are raised from
500 → 2000 chars. The cap stays as a guardrail against runaway
models dumping their working context; the data channel is the
durable side-channels (PR threads, PR comments, tracker comments,
SQLite). priorContext stays as a "what just happened" narration.

### I. Dashboard sub-iteration display

A new SQLite table tracks in-skill progress so the dashboard can
show finer-grained state than Jira (Jira sees one phase at a
time; the dashboard sees the substeps).

Table conceptually:

```
phase_sub_iterations
  issue_id
  phase_name
  sub_iter_index
  label                  -- "Codebase research", "Solution design", etc.
  status                 -- "in-progress", "completed", "failed"
  summary                -- short summary written on completion
  started_at
  completed_at
```

Skills write to this table via new CLI commands:

```
redqueen sub-iter start <issueId> <label>
redqueen sub-iter complete <issueId> --summary "..."
```

Dashboard polls or subscribes to this table and renders the current
sub-iteration alongside the phase. Example UI label:

> Prompt Writing → iter 1/3: Solution design

## Phase Graph Changes

### Removed phases

- `plan-review` — entire phase, skill (planning-review), CLI
  (`redqueen plan verdict`), and SQLite columns (`plan_review_*`).
- `spec-feedback` — collapsed into `spec-writing` via
  iteration-aware branching.

### Added phases

- `spec-research` — first sub-phase of the prompt-writer pipeline.
- `spec-design` — second sub-phase.

(Existing `spec-writing` remains, now means the third / final
sub-phase that writes the spec.)

### Re-pointed edges

- `spec-review.rework`: `spec-feedback` → `spec-writing`. (Since
  spec-feedback is gone and spec-writing handles rework via iter.)
- `code-review.escalateTo`: `human-review` → `testing` (final-test
  carve-out).

### Restored behavior

- `review_iterations` resets to 0 when `code-review` passes (Alice
  parity, currently absent in Red Queen).

## Skill Changes Summary

### prompt-writer (now spans three phases)

May be implemented as:

- **Option 1:** Three skill files (`spec-researcher`,
  `spec-designer`, `spec-writer`). Each focused, no branching
  needed. Slight duplication of shared setup (read codebase map,
  fetch attachments).
- **Option 2:** One skill file branching on `phaseName`. Single
  source of truth, slightly more complex skill.

Decision deferred to implementation; both work. Option 1 is
probably cleaner for debugging and observability.

### coder

- New `priorPhase` branching at top of skill flow.
- Rework-mode fetches threads or test comments based on
  `priorPhase`.
- Adds the calibration block on what feedback to apply vs push back
  on.
- Resolves threads with replies; never deletes.

### reviewer

- Drops rating entirely. Removes any "Rating" section from output.
- Fetches existing threads before opening new ones; implements the
  dedup logic.
- Posts blockers as inline review threads, improvements as PR body
  bullets.
- Exits non-zero on blockers (explicit, spelled out in SKILL.md).
- Adds calibration to respect pushbacks on resolved threads.

### tester

- Adds the structured PR comment publishing step with the parseable
  timestamp header.
- Otherwise unchanged.

### comment-handler

- No required changes. Stays as the handler for the human-review
  rework path (`human-review.rework: code-feedback`). It already
  fetches threads and works the rework pattern correctly. The
  AI-reviewer rework path is now handled by the rework-aware coder
  (mechanism E), not by comment-handler.

### planning-review

- Deleted entirely. No replacement.

## DB Schema Changes

### `pipeline_state` table additions

- `prior_phase TEXT NULL` — the phase that ran before the current
  dispatch. Set by orchestrator; consumed by the coder skill.
- `review_exhausted INTEGER NOT NULL DEFAULT 0` — boolean flag for
  the final-test carve-out.
- `open_question_count INTEGER NULL` — set by spec-writing's
  metadata CLI. Read by orchestrator to decide skip-gate.
- (Optional) `files_affected_count INTEGER NULL` — additional
  metadata if useful.

### `pipeline_state` table removals

- `plan_review_verdict TEXT`
- `plan_review_rating INTEGER`
- `plan_review_blockers INTEGER`
- `plan_review_open_questions INTEGER`
- `plan_review_recorded_at TEXT`

### New table: `phase_sub_iterations`

Conceptual columns (see mechanism I).

### Reset behavior

`resetIterations()` should also clear `review_exhausted` and
`prior_phase` alongside the iteration counters and (now-removed)
`plan_review_*` columns.

## CLI Changes

### New commands

- `redqueen spec meta <issueId> --open-questions N
  [--files-affected N]` — sets spec metadata after a writing pass.
  Orchestrator reads this for routing.
- `redqueen sub-iter start <issueId> <label>` — opens a new
  sub-iteration entry. Used by skills at the start of each
  internal sub-step.
- `redqueen sub-iter complete <issueId> --summary "..."` — closes
  the most recent open sub-iteration entry.
- `redqueen pr review-thread <prNumber> --file <path> --line
  <line> --body-stdin` — post an inline thread comment. OR extend
  `redqueen pr review` with a repeating `--inline file:line@body`
  flag. (Ergonomics call; either works.)

### Modified commands

- `redqueen pr comments --threads --filter <blocker|improvement>`
  — optional filter flag for the reviewer's dedup logic and the
  orchestrator's routing query.

### Removed commands

- `redqueen plan verdict` — entire command and its CLI handler.

## Calibration Notes

These are prompt-engineering challenges that the architecture
doesn't solve. Architecture provides the channels and routing;
clear skill prompts plus observed real-world runs make the system
actually work well.

### Reviewer calibration

- **No quota.** Explicitly tell the reviewer it has no minimum or
  maximum number of issues to find. "Find real issues. Skip
  nitpicks. There is no count cap or quota."
- **No rating.** Drop all 1-10 scoring. Binary "blockers / no
  blockers" is the routing signal.
- **Respect coder pushbacks.** When fetching existing threads,
  treat resolved threads (especially with a reasoned counter-reply
  from the coder) as decided. Do not re-flag the same issue
  unless new code legitimately changes the context. "If the coder
  pushed back with a valid reason and the situation has not
  changed, accept the pushback and move on."
- **Don't request defensive bloat.** Symmetric to the coder
  calibration. Don't ask for defensive code unless there's a
  documented failure mode the code doesn't handle.
- **Inline thread body format.** Each blocker comment should
  clearly explain the issue, why it blocks, and what specifically
  needs to change. No fluff.

### Coder calibration

- **Apply real fixes:** feedback that fixes a real bug, security
  hole, performance problem, or readability issue. Apply.
- **Push back when:** feedback adds defensive code for cases that
  can't happen; feedback adds abstractions for hypothetical-future
  needs; feedback contradicts the project's documented code style;
  feedback is technically right but the cost > benefit.
- **Pushback format:** "Disagree — <one-sentence reason, ideally
  citing project convention or a specific tradeoff>. Leaving
  as-is." Reply, then resolve the thread.
- **Never delete threads.** Always resolve via reply. Humans
  re-open if needed.
- **Bind to project code style.** Reference CLAUDE.md and
  `.redqueen/references/coding-standards.md` as authoritative for
  what "valid but not worth fixing" looks like.

### prompt-writer calibration

- **Research phase:** focused exploration, concise output. Name
  files / functions / patterns; do not propose solutions.
- **Design phase:** sketch the approach, list open questions, name
  key decisions. Do not write the spec.
- **Write phase:** try to answer open questions yourself before
  flagging for human. Re-read code, run focused checks. The fewer
  remaining open questions, the better — but don't fabricate
  answers.

### Tester calibration

- **Result tagging:** use a clearly-parseable header so the coder
  finds the latest results unambiguously.
- **Failure classification:** distinguish new test failure due to
  PR changes (route to coding) from infra failure like missing
  schema or env (post Blocked to tracker, don't loop on coder).
- **Don't edit prior comments.** Always append a new comment.
  History is valuable.

### Reviewer ↔ Coder disagreement handling

The most fragile part of the calibration story. The architecture
treats a resolved-with-pushback thread as "decided" and asks the
reviewer to respect that. In practice:

- Reviewer must read existing thread bodies + replies, not just
  resolution state.
- When the reviewer thinks a coder pushback is wrong, the
  reviewer should **not** re-open the thread or open a duplicate.
  Instead, leave the original thread alone and flag the concern
  in the PR review body as an improvement. The human reviewer
  can adjudicate on the spec-review or human-review gate.
- This is a prompt-engineering challenge that will need iteration
  on real runs to dial in.

## Open Questions / Future Work

These were discussed and deliberately deferred:

- **Global codebase map at `redqueen init`.** Pre-generated map of
  modules / entry points / build config. Would save per-issue
  research tokens but drifts over time. Skipped until the system
  is otherwise stable. The drift problem outweighs the
  optimization until we have observability on the in-skill
  iteration costs.
- **Per-issue codebase notes checked into the repo.** Considered
  and rejected; SQLite is cleaner and lets the dashboard render
  them.
- **Explicit "spec-restart" CLI / phase.** Current design relies
  on rework-with-empty-spec for the wholesale-rewrite case. Add
  an explicit command later if the implicit path proves
  unreliable.
- **Improvements UI in dashboard.** Current orchestrator routes
  only on blocker count. Improvements are visible to humans on
  the PR body; no specific dashboard treatment.
- **Reviewer / coder disagreement arbitration.** No formal
  escalation mechanism when the reviewer keeps re-flagging
  pushed-back issues. May need a "request human input on disputed
  thread" signal if calibration alone proves insufficient.
- **Real product-level testing.** Today's testing is unit tests +
  CI; the aspirational goal is actual product testing
  (Playwright MCP and similar). Bigger architectural lift;
  separate redesign cycle.

## Suggested Implementation Phasing

This is a large redesign. Recommend breaking into independently
shippable phases, with a design conversation at the start of each:

**Phase 1 — Foundation cleanup**

- Raise `SUMMARY_MAX_LEN` and `ERROR_MAX_LEN` to 2000.
- Remove plan-review phase, planning-review skill, plan_review_*
  columns, `redqueen plan verdict` CLI, and any dead code that
  referenced them. Keep unrelated improvements that landed in
  the same commit (e.g. the gate-leave reset, spec-content
  re-sync) — don't bulk-revert.
- Restore `review_iterations` reset on code-review pass (Alice
  parity).
- Add `phase_sub_iterations` table and the sub-iter CLI commands.

This phase has no user-visible new functionality but removes the
broken pipe and sets up scaffolding for the rest.

**Phase 2 — Multi-phase prompt-writer**

- Add `spec-research` and `spec-design` phases to the default
  phase graph.
- Re-point `spec-review.rework` from `spec-feedback` to
  `spec-writing`. Remove `spec-feedback` from the phase graph.
- Refactor (or split) the prompt-writer skill into the three
  phases with `phaseName` / `iterationCount` branching.
- Add the `redqueen spec meta` CLI and the `open_question_count`
  column. Wire orchestrator to read it for skip-gate decisions.

After this phase: spec generation works end-to-end with the new
loop; no plan-review involvement; no spec-feedback phase.

**Phase 3 — Inline review threads**

- Extend reviewer skill to fetch existing threads, dedup, post
  inline blockers + PR body improvements.
- Drop rating from reviewer output.
- Add the inline thread CLI (extend `redqueen pr review` or add
  `redqueen pr review-thread`).
- Update orchestrator routing on unresolved blocker count.

After this phase: code review feedback uses inline threads;
rating is gone; orchestrator routes on a deterministic signal.

**Phase 4 — Rework-aware coder + testing publishing**

- Add `priorPhase` to the YAML context block and orchestrator
  dispatch logic.
- Update coder skill with the `priorPhase` branching and rework
  flows.
- Update tester to post structured PR comments on each run.

After this phase: coder receives feedback from the right
side-channel based on what kicked it back; testing results are
durable on the PR.

**Phase 5 — Final-test carve-out**

- Add `review_exhausted` column and orchestrator logic.
- Change `code-review.escalateTo` to `testing`.
- Implement the failure-handler logic that checks the flag.

After this phase: the "reviewer over-strict" failure mode is
covered by the final-test pass before human escalation.

**Phase 6 — Dashboard integration**

- Read `phase_sub_iterations` from the dashboard.
- Render the current sub-iteration label alongside the phase.

After this phase: the dashboard shows fine-grained spec-writing
progress (which Jira can't see because it only knows about
phases).

---

## How to Use This Doc

- Re-read before starting any implementation phase.
- Each phase above should get its own design conversation before
  implementation, focused on edge cases and skill-prompt
  specifics. Use the corresponding section of "HOW Each Mechanism
  Works" and the "Calibration Notes" as the conversation starter.
- When in doubt, consult the "Architectural Principles" section —
  it captures the through-line that should guide all the small
  decisions.
- The "Decisions Locked" list is the contract. Don't relitigate
  those unless a new constraint surfaces.
