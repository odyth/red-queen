# Red Queen v6 — Phase 4: Rework-Aware Coder + Testing Publishing

> Standalone execution plan. Every load-bearing decision is re-encoded here; no need to read `redqueen-v6.md` to execute. (Phase 3's inline-review-threads work was deliberately dropped after analysis showed it's a human-ergonomics nicety, not an AI-rework win; its only surviving piece — removing the reviewer's 1-10 rating — is folded in here.)

## 1. Executive Summary

The automated loops kick a failed phase back to an earlier phase, but the earlier phase is **not told it's reworking and is not handed the feedback as structured input**. The clearest case: `code-review` finds blockers → routes to `coding`, but the coder skill is a pure fresh-write flow. It has no signal that it's on a rework round, its iteration count is always `0` (a string-match bug), and it has no instruction to fetch the review. Whether it addresses the feedback is luck. The identical gap exists on `testing → coding`.

This phase fixes the handoff on both edges:

1. Add a stored **`prior_phase`** so a dispatched skill knows what ran before it (fresh vs review-rework vs test-rework). Derivation is impossible — `coding` follows both `code-review` and `testing`, and `review_iterations` is >0 in both — so it must be stored.
2. Give the coder a **correct iteration count** via a small `iterationCounter` phase-config field (replaces the brittle phase-name string match).
3. Make the **coder branch on `priorPhase`**: on review-rework it fetches the latest review body and addresses blockers (fix or reasoned push-back); on test-rework it reproduces the failure locally and fixes it; otherwise it runs the existing fresh-write flow.
4. Make the **tester publish a structured results comment** to the PR each run (durable, human-visible).
5. **Drop the reviewer's 1-10 rating** (cosmetic — never read by routing; invites gradient-justification drift). Keep the binary verdict.

Two small source-control adapter methods are added (`getReviews`, `postPrComment`). No orchestrator routing changes.

## 2. Context & Background

### What's confirmed in the current code

- **Routing is exit-code only.** `runWorker` sets `success = exitCode === 0 && killed === false` (`worker.ts:200-220`). No rating/verdict parsing anywhere. The reviewer's `7/10` is decoration in the posted report.
- **`coder/SKILL.md` is fresh-write only.** No `priorPhase`/rework branch, no instruction to fetch a review (`redqueen pr ...` review-read), no use of `iterationCount`. Step 3 reuses an existing worktree but only rebases it.
- **The coder's iteration count is always 0.** `relevantIterationCount` (`skill-context.ts:92-100`) matches `"coding".includes("review")` → false and `…("feedback")` → false → `0`.
- **`prior_phase` is not tracked.** `pipeline_state` has `current_phase` + `prior_context` only. `updatePhase` (`pipeline-state.ts:59`) is the single mutator of `current_phase`; every transition path funnels through it (`orchestrator.ts:402,537,868,948,1116`, and the `redqueen issue set-phase` CLI via `respectAgentPhaseChange:868`).
- **`priorContext` is written on success only** (`orchestrator.ts:817`, `handleSuccess`). On a code-review fail (→ coding) it is not refreshed with the reviewer's output, so the coder can't rely on it for feedback.
- **`review_iterations` increments in `handleFailure`** for any automated `onFail` (`orchestrator.ts:1060`), and `resetReviewIterationsOnPass` zeroes it on a code-review pass (`orchestrator.ts:830`). `resetIterations` (`pipeline-state.ts:164-172`) zeroes only the two counters.
- **`comment-handler` is a separate loop** (the `human-review → code-feedback` path). It fetches threads, replies, doesn't resolve. No overlap with the `code-review → coding` loop. Leave it untouched.
- **Adapter capabilities** (`src/integrations/github/adapter.ts`, interface `src/integrations/source-control.ts`): already has `getReviewThreads` (GraphQL), `replyToComment`, `postReview`, `getPullRequestDiff`, and uses `rest.pulls.listReviews` internally inside `dismissStaleReviews` (`adapter.ts:199`). Missing: a public "read review bodies" method and a "post PR-level comment" method.

### Known quirks (acknowledged, out of scope)

- `testing` has no `maxIterations` (`defaults.ts:59-67`), so a testing failure increments `review_iterations` uncapped, conflating it with the code-review loop's counter. The coder picks its mode from `priorPhase`, not the count, so this does not break Phase 4. Counter-semantics cleanup was Phase 2 territory; deferred.

## 3. Goals / Non-Goals

### Goals
- Coder knows fresh vs review-rework vs test-rework via `priorPhase`, and sees the correct rework round via `iterationCount`.
- On review-rework the coder fetches the actual review and addresses each blocker (fix or reasoned push-back).
- On test-rework the coder reproduces the failure locally and fixes it.
- Tester posts a structured, append-only results comment to the PR each run.
- Reviewer no longer emits a 1-10 rating; binary verdict only.
- `npm run check` + existing tests stay green; new tests cover `prior_phase`, the counter-field selection, and the two new CLIs/adapter methods.

### Non-Goals
- Inline PR review threads, thread dedup/resolution, GraphQL mutations (dropped Phase 3).
- `review_exhausted` flag / `code-review.escalateTo → testing` (dropped Phase 5).
- Dashboard rendering (dropped Phase 6).
- Multi-phase spec pipeline / spec-side feedback rework (dropped Phase 2).
- Touching `comment-handler` or the `human-review → code-feedback` path.
- Counter-reset semantics rework (the dead `feedback_iterations` cap).
- Making the reviewer respect coder push-backs automatically across rounds (see §8).

## 4. Design Decisions

**D1 — `prior_phase` column, set at the single chokepoint.** Add `prior_phase TEXT` (nullable) to `pipeline_state`. In `updatePhase` (`pipeline-state.ts:59`) shift atomically:
```sql
UPDATE pipeline_state SET prior_phase = current_phase, current_phase = ?, updated_at = ? WHERE issue_id = ?
```
SQLite evaluates RHS against the pre-update row, so `prior_phase` captures the outgoing phase. Correct for every transition path because all of them call `updatePhase`. Not touched by `resetIterations`.

**D2 — `iterationCounter` phase-config field.** Add `iterationCounter?: "review" | "feedback" | "none"` to `PhaseDefinition` (`types.ts`) and its Zod schema (`config.ts`). Rewrite `relevantIterationCount` to switch on it, with a legacy fallback so untouched phases keep working:
```ts
function relevantIterationCount(phase: PhaseDefinition, record: PipelineRecord): number {
  switch (phase.iterationCounter) {
    case "review": return record.reviewIterations;
    case "feedback": return record.feedbackIterations;
    case "none": return 0;
    default:
      if (phase.name.includes("feedback")) return record.feedbackIterations;
      if (phase.name.includes("review")) return record.reviewIterations;
      return 0;
  }
}
```
Set `coding.iterationCounter = "review"` in `defaults.ts` (review-fail bumps `review_iterations` before the transition, so the coder sees `1` on round 1). `buildSkillContext` already has the `PhaseDefinition` (`skill-context.ts:28`); pass it instead of `phaseName` to `relevantIterationCount`.

**D3 — `priorPhase` in the skill context.** Add `priorPhase: string | null` to `PipelineRecord` (read from the new column) and to `SkillContext`. Set it in `buildSkillContext` from `pipelineRecord.priorPhase`. YAML serialization is automatic (`renderSkillPrompt` stringifies the whole context object, `skill-context.ts:103`).

**D4 — Coder branches on `priorPhase`.** At the top of the execution flow:
- `"code-review"` → review-rework mode.
- `"testing"` → test-rework mode.
- anything else (`null`, `"spec-review"`, `"blocked"`, …) → existing fresh-write flow.

**D5 — Review-rework feedback source.** The reviewer posts its report as the review **body** (via `pr review`, which calls `postReview`). The coder reads the latest one via a new `redqueen pr reviews <n> --latest`. Push-back has no thread to resolve, so the coder records disagreements in a single PR comment (`redqueen pr comment <n>`); the next review pass and the human gate can see it.

**D6 — Test-rework feedback source.** The coder reproduces locally (authoritative): rebase the worktree, re-run build + targeted tests, fix, re-run until green. The tester's PR comment is for humans; the coder does **not** depend on reading it (avoids a third adapter method). Failures that reach `coding` are real and reproducible — infra/flaky failures are routed to `blocked` by the tester, not to coding.

**D7 — Adapter additions** (`source-control.ts` interface + `github/adapter.ts`):
- `getReviews(prNumber): Promise<Review[]>` — `{ id, author, body, state, submittedAt }`, `state ∈ APPROVED|CHANGES_REQUESTED|COMMENTED`. Reuse the `client.paginate(client.rest.pulls.listReviews, …)` pattern already at `adapter.ts:199`.
- `postPrComment(prNumber, body): Promise<void>` — `client.rest.issues.createComment({ owner, repo, issue_number: prNumber, body })` (PRs accept issue comments).

**D8 — Reviewer rating removal.** In `reviewer/SKILL.md` delete the `## Rating` section (~line 137-138) and drop `Rating: X/10` from the approve summary (line 179). Keep the `## Verdict` section. **Do not touch the verdict/exit path** (Step 6 "Decide", the `--verdict` posting).

**D9 — No orchestrator routing changes.** `escalateTo` stays `human-review`. The only orchestrator-adjacent change is `updatePhase` (D1); dispatch already passes the full `pipelineRecord` to `buildSkillContext`.

## 5. Implementation Steps

1. **Schema** — add `prior_phase TEXT` in `database.ts` `runMigrations` (use the existing duplicate-column-swallow pattern). Update `PipelineRow`, `PipelineRecord`, `toPipelineRecord` (`pipeline-state.ts`, `types.ts`). Modify `updatePhase` to the shift SQL (D1). Confirm `resetIterations` untouched.
2. **Counter field** — `PhaseDefinition.iterationCounter` (`types.ts`) + Zod (`config.ts`); rewrite `relevantIterationCount` (D2); `buildSkillContext` passes `phase`; set `coding.iterationCounter = "review"` (`defaults.ts`).
3. **`priorPhase` in context** — add to `SkillContext` + `buildSkillContext` (D3).
4. **Adapter** — `getReviews`, `postPrComment` on the interface + GitHub adapter (D7).
5. **CLI** (`src/cli/pr.ts`) — `cmdPrReviews` (`pr reviews <n> [--latest] [--pretty]`) and `cmdPrComment` (`pr comment <n> --body|stdin`, reuse `readBodyFromStdinOrFlag` from `src/cli/io.ts`). Register in the subcommand switch + help text (`pr.ts:28-29`).
6. **Coder skill** — add the `priorPhase` branch + review-rework and test-rework modes + calibration block (§7.1).
7. **Tester skill** — add the results-comment publish step (§7.2).
8. **Reviewer skill** — rating removal (§7.3).
9. **Tests** (§6).
10. **`npm run check` + `npm test`** until green. Commit per logical step.

## 6. Acceptance Criteria

- [ ] `pipeline_state.prior_phase` exists; `updatePhase` sets it to the outgoing phase; `resetIterations` leaves it intact (unit test).
- [ ] Fresh `coding` dispatch sees `priorPhase: null`; after a code-review fail it sees `priorPhase: "code-review"` and `iterationCount: 1`; after a testing fail it sees `priorPhase: "testing"`.
- [ ] `PhaseDefinition.iterationCounter` validates; `coding` → `review_iterations`; untouched phases keep their counts via fallback (unit test).
- [ ] `SourceControl.getReviews` / `postPrComment` implemented; `redqueen pr reviews <n> --latest` returns the latest review body; `redqueen pr comment <n>` posts a PR comment.
- [ ] `coder/SKILL.md` branches on `priorPhase`: review-rework fetches `pr reviews --latest` and addresses blockers; test-rework reproduces locally; else fresh.
- [ ] `tester/SKILL.md` posts a `## Test Results — <ISO>` comment each run (append-only).
- [ ] `reviewer/SKILL.md` has no `## Rating`/`X/10`; binary verdict intact; verdict/exit path unchanged.
- [ ] `comment-handler/SKILL.md` unchanged; no `prior_phase`/`review_exhausted`/inline-thread code anywhere.
- [ ] `npm run check` and `npm test` pass.

## 7. Skill Prompt Changes (concrete)

### 7.1 `coder/SKILL.md`
- New `Step 0: Determine mode` at the top of `## Execution`, reading `priorPhase` + `iterationCount`; route to fresh / review-rework / test-rework.
- **Review-rework**: refresh worktree (fetch + rebase) → `redqueen pr reviews "${prNumber}" --latest` → for each blocker, fix it, or push back when it's defensive code for an impossible case / a hypothetical-future abstraction / a style ask contradicting `coding-standards.md` or `CLAUDE.md`; apply non-blocking improvements only if quick + clearly correct → if any push-backs, post one `redqueen pr comment "${prNumber}"` summarizing them → build/test/commit/push, no new PR → exit 0.
- **Test-rework**: refresh worktree → re-run build + targeted tests locally (authoritative) → fix until green → commit/push, no new PR → exit 0.
- Note: when `iterationCount >= maxIterations`, this is the last automated attempt before human escalation — be decisive.

### 7.2 `tester/SKILL.md`
- After computing results, before exiting, post (append-only; never edit prior comments):
  ```
  cat <<'EOF' | redqueen pr comment "${prNumber}"
  ## Test Results — <ISO timestamp>
  - Build: <pass|fail>
  - Targeted: <n/n> <pass|fail>
  - Full: <m/m> <pass|fail>
  - CI: <pass|fail|pending>
  <brief failure summary if any>
  EOF
  ```
- Exit behavior unchanged (0 = pass → human-review; non-zero = fail → coding).

### 7.3 `reviewer/SKILL.md`
- Remove `## Rating` (~137-138); drop `Rating: X/10` from the approve summary (179). Keep `## Verdict`. No other changes.

## 8. Out of Scope / Known Limitations

- Inline threads, dedup, GraphQL mutations; `review_exhausted`; dashboard; multi-phase spec; counter-reset rework. Do not touch `comment-handler` or `human-review → code-feedback`.
- **Cross-round disagreement isn't auto-respected.** Without threads, a coder push-back is recorded in a PR comment but the next reviewer pass re-reviews fresh and may re-flag it. A genuine standoff converges to `human-review` after `maxIterations` (3) — the human adjudicates. Acceptable; this is the arbitration problem v6 punted on regardless.

## 9. Pre-flight to verify before implementing

- **Reviewer fail-signal mechanism.** The reviewer posts `--verdict request-changes` with no visible `exit 1`, and `pr review` returns exit 0 (`pr.ts:164`) — yet `code-review → coding` demonstrably fires (the user observes it). Confirm exactly how the worker's non-zero exit (the orchestrator's only fail signal, `worker.ts:200`) is produced on blockers. If it's implicit/fragile, make it explicit in `reviewer/SKILL.md` (end with `exit 1` on request-changes). Same handoff-reliability class as the bug being fixed; worth hardening here. Rating removal does not touch this path.

## 10. Verification (end-to-end)

- **Unit/integration** (vitest): `pipeline-state` (prior_phase shift + reset-safety); `skill-context` (counter-field selection + fallback, `priorPhase` in context/YAML); adapter (`getReviews`, `postPrComment` against mocked octokit); `cli/pr` (`reviews --latest`, `comment`).
- **Orchestrator/e2e**: drive coding → code-review (force a blocker) → assert next coding dispatch has `priorPhase: "code-review"`, `iterationCount: 1`, and the coder fetches the review; drive a testing failure → assert `priorPhase: "testing"`; assert a fresh ticket's first coding has `priorPhase: null`.
- **Manual smoke** (if a Jira/GitHub sandbox is available): one issue through coding → seed a review blocker → confirm the coder reads it and addresses it; force a test failure → confirm the coder reproduces and fixes it; confirm a `## Test Results` comment appears on the PR and the reviewer report has no rating.
