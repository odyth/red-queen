# Blocked Checkpoint — Preserve Coder Work When a Ticket Blocks

**Date:** 2026-07-17
**Status:** Approved design, pending implementation
**Scope:** `src/skills/coder/SKILL.md`, `src/core/failure-notice.ts`, `src/core/orchestrator.ts` (one call site), `src/core/__tests__/failure-notice.test.ts`

## Problem

When the coder hits a blocker after substantial implementation (most commonly an
infrastructure-dependent build/test failure: missing migration, env var,
external service), the Blocked path posts a tracker comment and sets the phase
to `blocked` — but never commits, pushes, or opens a PR. The work sits
uncommitted in `.redqueen/worktrees/<issueId>` on the host:

- **Invisible** — the human sees a prose comment, not the code.
- **Unprotected** — host dies, work dies. Nothing reaches the remote.
- **Resume-hostile** — unblock routes to `coding` fresh-write mode, whose
  Step 3 runs `git rebase` on the existing worktree; a dirty tree makes that
  fail, so resume behavior is nondeterministic.

A second, adjacent hole: if the worker process dies before reaching the Blocked
path at all, the orchestrator's failure notice tells the human the phase failed
but not that a worktree with unpushed work exists.

## Decisions (made during design review)

1. **Trigger:** checkpoint on *any* block with work present — one rule, no
   failure-type classification by the agent. If the worktree has changes (or
   unpushed commits) when the Blocked path runs, checkpoint them.
2. **Draft lifecycle:** the checkpoint PR is created with `--draft` and stays
   draft through the pipeline. A human clicks "Ready for review" in the GitHub
   UI at the human-review gate. No undraft code (GitHub allows draft→ready only
   via GraphQL; not worth an adapter method for one human click).
3. **Backstop:** worker-death stranding is handled by a one-line addition to
   the failure notice, not by core git automation. Core never runs git; that
   invariant holds.

## Design

### 1. Coder skill — Blocked path checkpoint (`src/skills/coder/SKILL.md`)

Insert a new step at the top of the **Blocked path** (before the tracker
comment):

> **Checkpoint work in progress.** If `git -C "${worktree_path}" status
> --porcelain` is non-empty or the branch has commits not on the remote:
>
> 1. Stage only files you created or modified (never `git add -A`), commit as
>    `chore(<issueId>): checkpoint — blocked: <short reason>`.
> 2. `git -C "${worktree_path}" push -u origin "${branch_name}"`.
> 3. If `prNumber` is null, create the PR now with `--draft` — same command as
>    Step 8 plus the `--draft` flag. Body = normal Step 8 body plus a
>    `## Blocked` section stating the cause and what a human must do. If
>    `prNumber` is non-null, the push alone updated the existing PR.
>
> Checkpointing is best-effort: if commit, push, or PR creation fails, note it
> in your summary and continue blocking — never let the checkpoint prevent the
> block itself.

Amend the existing blocked tracker-comment template with one line:

> `Checkpoint: PR #<n> (draft)` — omit if checkpointing failed or there was no
> work to checkpoint.

The existing step "if a PR exists, post a request-changes review" now naturally
fires on the checkpoint PR — no change needed there.

### 2. Coder skill — resume path guards

- **Step 3** (worktree reuse) gains one sentence: the branch may already
  contain checkpoint commits from a prior blocked round — continue from them;
  do not reimplement work that already exists.
- **Step 8** (create PR) gains a guard: if `prNumber` is non-null in the
  context block, skip creation — Step 7's push already updated PR
  `#${prNumber}`. (Without this, resume hits GitHub 422 "A pull request
  already exists".) The PR may still be a draft; leave it — a human flips it
  at the human-review gate.

### 3. Failure-notice backstop (`src/core/failure-notice.ts` + call site)

- `FailureNoticeInput` gains `worktreePath: string | null`.
- In the generic (non-auth) notice branch, when `worktreePath` is non-null,
  append one line after the routing paragraph:

  > Unpushed work may exist in the worktree at `<path>` on the Red Queen host.

  The auth branch is unchanged (auth failure is host-global; the note is
  noise there).
- Call site (`orchestrator.ts` `postFailureNotice`): pass
  `worktreePath: this.deps.pipelineState.get(issueId)?.worktreePath ?? null`.
  The field is exactly non-null when the coder recorded a worktree (skill
  Step 3 `redqueen pipeline update --worktree`), so no new state is needed.

## What does not change

- Orchestrator phase logic, phase graph, pipeline-state schema.
- `redqueen pr create` — `--draft` already exists (`src/cli/pr.ts:50`) and
  already records `prNumber` in pipeline state atomically;
  `skill-context.ts` already injects `prNumber` into every dispatch.
- Tester / reviewer skills — they block post-PR; their existing
  request-changes step already covers visibility.
- Core PR gating — `requiresPr` only drives stale-review dismissal, so an
  early PR is inert to the orchestrator.

## Testing

- Extend `src/core/__tests__/failure-notice.test.ts`: one case asserting the
  worktree line renders when `worktreePath` is set, one asserting it is absent
  when null.
- Skill changes are prompt text; the existing tracker-neutral test covers them
  automatically (checkpoint uses `redqueen` commands, no `gh`).
- `npm run check` must pass.

## Accepted trade-offs / risks

- **Prompt compliance is probabilistic.** The checkpoint executes at the worst
  moment of a worker run. The stateful part (PR + pipeline-state write) is one
  atomic helper call, which limits damage. Escalation path if this flakes in
  practice: a `redqueen checkpoint <issueId>` CLI command that does
  commit+push+draft-PR atomically (approach C from design review).
- **Push can fail when the infra failure is network/auth.** Then no remote
  checkpoint is possible by any mechanism; the local commit still makes the
  later resume rebase deterministic, and the failure-notice line points at the
  worktree.
- **A checkpoint PR makes PR-exists behavior reachable earlier** (e.g. a human
  manually re-routing a blocked ticket to spec phases). No orchestrator gate
  keys on PR existence today, so this changes nothing mechanically.

## Acceptance criteria

1. Coder blocking with uncommitted work commits, pushes, and (when no PR
   exists) opens a draft PR whose body carries the block reason; the tracker
   comment links it.
2. Coder blocking with no work present behaves exactly as today.
3. Unblock → coding resumes from checkpoint commits and does not attempt a
   second PR.
4. Worker-death failure notices name the worktree path when one is recorded.
5. `npm run check` and the full test suite pass.
