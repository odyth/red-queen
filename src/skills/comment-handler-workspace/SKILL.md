---
name: comment-handler-workspace
description: Addresses human review feedback across the PR set of a multi-repo workspace by implementing requested changes, replying to comments, and pushing an updated commit per repo. Use when a reviewer has left comments on one or more PRs of a workspace change-set and they need to be resolved before re-review.
license: MIT
compatibility: Designed for the Red Queen orchestrator pipeline (multi-repo workspace installs)
metadata:
  phase: feedback
  version: "1.0"
---

# Comment Handler

You address human review feedback on the existing PRs of one issue by
implementing requested changes, answering questions, and pushing an updated
commit per repo. Your goal is to resolve every comment so the reviewer can
re-review.

This install is a multi-repo workspace. One issue can change several
repositories; each repo it touches gets its own branch, worktree, and PR, and
those PRs form one change-set.

## Logging rule

Routine progress goes to the audit log. Only post a tracker comment when:

1. You route to **Blocked** — explain what blocks and what the human must
   do.
2. You cannot proceed (PR missing, worktree missing, etc.).

## Input

Read the YAML context block. Fields you rely on:

- `issueId` — the issue key. Used for worktree paths, attachments, and
  commit messages.
- `iterationCount` / `maxIterations` — hard limit on how many rounds of
  feedback you attempt before escalating to human review.
- `projectDir` — absolute workspace root. It is **not** a git repository.
  Worktrees live under `${projectDir}/.redqueen/worktrees`.
- `specContent` — the current spec (refreshed from the tracker on each
  dispatch), for reference if feedback questions the scope.
- `repos` — every configured repo. Each entry supplies `name`, `path`,
  `baseBranch`, `branchName`, `prNumber`, `terminalPrNumber`,
  `mergeCompleted`, `inScope`, `buildCommand`, `testCommand`, and `module`.
  An entry's `prNumber` is its active PR — the PR to update.

How to treat each `repos` entry:

- **Unfinished in-scope** (`inScope: true`, `mergeCompleted: false`) — the
  only entries you act on. Handle feedback only on those that also have a
  non-null `prNumber`; Step 1 covers the ones that do not.
- **Completed** (`mergeCompleted: true`) — this repo already merged in the
  current cycle. Skip its feedback, build/test, and every branch, worktree,
  PR, and pipeline mutation. Include it in the summary using
  `prNumber ?? terminalPrNumber`, labeled merged. `terminalPrNumber` alone is
  historical identity, not evidence of current-cycle completion.
- **Orphaned** (`inScope: false` with a non-null `prNumber`) — report it as
  **ORPHANED**, for a human to close or merge. Do not change or reply to it.
- Any other entry is not part of this issue. Leave it alone.

Rules that hold for every step:

- Ignore the top-level `baseBranch`, `buildCommands`, `testCommands`,
  `module`, `branchName`, `prNumber`, and `stackPrBase`. They describe a
  single repo; use each `repos` entry's own fields.
- Every `redqueen pr` subcommand and every `redqueen pipeline update` call
  passes `--repo <name>`, including the exhausted-iteration and blocked
  reviews.
- Run raw git with `-C <repo.path>` or inside that repo's worktree.
- Never rebase a stacked worktree.
- Never infer or expand scope from feedback, paths, or keywords.
- Process repos in `repos` order.

The worktrees are the ones the coder created, one per unfinished in-scope
repo: `${projectDir}/.redqueen/worktrees/${issueId}/${repo_name}`, with
`repo_name` bound from that entry's `name`.

## Setup

1. If `codebaseMapPath` is non-null, read it.
2. If `.redqueen/references/coding-standards.md` exists, read it.

## Execution

Steps 1–3 run once for the ticket. Steps 4–9 run once per usable entry
(Step 1 defines usable), in `repos` order. Step 10 summarizes the whole set
and makes one final routing/exit decision.

Only Step 1's completed-set exit and Step 2's exhaustion exit end the run
before Step 10.

### Step 1: Inspect the PR set

Inspect the whole `repos` set before any feedback work.

If the in-scope set is non-empty and every in-scope entry has
`mergeCompleted: true`, report the completed set and any orphaned PRs, then
exit 0 without feedback, worktree setup, build/test, or mutations.

For every unfinished in-scope entry (called `r` in prose), bind these shell
variables from its context values before using the command examples:

- `repo_name` = `r.name`; `repo_path` = `r.path`.
- `repo_pr_number` = `r.prNumber`; use PR commands only when non-null.
- `repo_branch` = the recorded `r.branchName`; `repo_base` = `r.baseBranch`.
- `repo_worktree` = `${projectDir}/.redqueen/worktrees/${issueId}/${repo_name}`.

Rebind for every entry. Verify its worktree exists and is on `repo_branch`
before changing files.

An unfinished in-scope entry is **incomplete** when any of these is true:

- Its `prNumber` is null (no active PR).
- Its worktree is missing.
- Its recorded branch is missing.
- Its worktree is on a branch other than `repo_branch`.

For an incomplete entry, record the cause, skip its feedback work, and
process the other usable unfinished entries. An unfinished in-scope entry
with none of these problems is **usable**.

The set is **incomplete** when any unfinished in-scope entry is incomplete,
or when the in-scope set is empty.

Never substitute a historical PR for a null `prNumber`, regenerate a branch
from the current prefix, switch branches, or create a worktree or PR here.
Step 10 routes an incomplete set to coding, after Step 2's ticket-wide
iteration check and the per-repo loop.

### Step 2: Check the iteration limit

Check this limit once for the ticket, before any feedback work.

If `iterationCount >= maxIterations`, you have exhausted automated
attempts. Post a PR review note on every unfinished in-scope entry with a
non-null `prNumber`, rebinding its variables for each review:

```
echo "Escalating after ${iterationCount} feedback iterations — human review needed." | redqueen pr review "${repo_pr_number}" --repo "${repo_name}" --verdict request-changes
```

Never post these notes on completed or orphaned PRs.

Record any failed review calls, then summarize the full set and the
exhaustion: "Escalating to human — iteration limit reached." Exit non-zero
immediately so the orchestrator escalates. Do not enter Steps 3–9, and do
not route missing inputs to coding after exhaustion.

### Step 3: Fetch attachments

Fetch attachments once for the ticket, not once per repo:

```
redqueen issue attachments <issueId>
```

If the JSON output is a non-empty array, read each `localPath` with
vision (screenshots frequently carry information the text omits).
Re-fetch in case the human attached new images alongside the feedback.

### Per-repo loop: Steps 4–9

Run Steps 4–9 once per usable entry, in `repos` order, with that entry's
variables bound.

A failure can skip unsafe work for that repo, but must not exit before
processing its siblings. Keep comments, category counts, build/test results,
commit hashes, push/reply status, and failures keyed by repo name and active
PR number; reset these for every repo.

### Step 4: Fetch unresolved review threads

Fetch this repo's threads:

```
redqueen pr comments "${repo_pr_number}" --repo "${repo_name}" --threads
```

On fetch failure, record it and continue to the next repo; do not treat
unavailable comments as an empty, successfully handled list.

This returns an array of `ReviewThread` objects. Each has `threadId`,
`isResolved`, `isOutdated`, `path`, `line`, and `comments` (an array of
`{id, author, body, createdAt}`). By default only unresolved threads are
returned — you will never see threads the human has already resolved on
the PR UI, so you will not re-address old feedback across rounds.

Work only on threads with `isResolved === false`. Your replies do **not**
resolve the thread; after you push the fix, the human verifies and marks
the thread resolved on the PR UI.

### Step 5: Categorize thread comments

For each unresolved thread, look at the newest human comment on that
thread and decide:

1. **Actionable change** — concrete request to modify code (e.g. "rename
   this variable", "add error handling here", "this query is vulnerable").
2. **Question** — asking for reasoning or clarification. Answer requires
   no code change unless the question reveals a real issue.
3. **Already addressed** — the human has not yet resolved the thread but
   the current code already satisfies the feedback. Reply explaining what
   changed and where; do not resolve the thread yourself.

### Step 6: Implement changes

Implement only this repo's feedback, working inside `repo_worktree` and
following the repo's own `CLAUDE.md` and `AGENTS.md` when present:

- For each **actionable change**: read the file, apply the change,
  follow the coding-standards reference.
- For each **question** that reveals a real issue: apply the fix too.
- Track what you changed so your reply is specific.

Respect the approved spec and its cross-repo contracts. Feedback requiring
changes to a completed or out-of-scope repo needs a human scope decision;
flag that limitation on the affected active PR without changing those repos
or claiming the feedback is complete.

### Step 7: Build and test

Run the build and targeted tests inside `repo_worktree`. Choose commands
afresh for each `r`:

- Build: `r.module.buildCommand` if `r.module` is non-null, else
  `r.buildCommand`.
- Tests: `r.module?.testCommandTargeted ?? r.testCommand`.

Never use top-level or sibling commands.

If either fails, fix and retry (up to 3 attempts per repo).

Missing or unavailable commands, or persistent failures, leave this repo's
checks unverified or failed. In that case:

- Skip Step 8 for this repo — do **not** commit or push.
- Give truthful pending replies in Step 9.
- Record the failure and continue to the sibling repos.

Do not exit here. Step 10 makes the final exit decision.

### Step 8: Commit and push

Commit only after this repo's checks pass. Stage only the files you
modified in this repo. One commit per repo per feedback round, not per
comment; answer-only rounds need no empty commit. Push the existing
recorded branch:

```
git -C "${repo_worktree}" add <files>
git -C "${repo_worktree}" commit -m "fix(${issueId}): address review feedback

- <bullet summary of changes>

Refs: ${issueId}"
git -C "${repo_worktree}" push origin "${repo_branch}"
```

Record commit and push outcomes separately for each repo. On failure, do
not claim changes were delivered; record the failure, follow the **Blocked
path** when applicable, and continue with truthful replies and the
remaining repos.

### Step 9: Reply to every unresolved thread

For each unresolved thread in this repo, reply to the first (or newest
human) comment. Bind `repo_comment_id` from the chosen comment's
`comments[].id` in this repo's fetched thread, then reply:

```
echo "<reply>" | redqueen pr reply "${repo_pr_number}" "${repo_comment_id}" --repo "${repo_name}"
```

Use the `id` of the comment you are replying to (GitHub's REST comment
ID; the CLI gave it to you in the `comments[].id` field). Keep each reply
with its repo's thread.

Reply format:

- **Actionable change:** "Done — <what you changed and why>."
- **Question:** "<clear answer with code reference if needed>."
- **Already addressed:** "Addressed in <commit hash or previous
  iteration> — <explanation>."

A failed build or push requires a pending explanation, not "Done". Record
failed replies and continue with the remaining threads and repos.

Your reply does not resolve the thread. Only humans resolve threads, on the
PR UI after verifying.

Do not leave any comment unanswered.

### Step 10: Summary and exit

Write a compact set summary listing each in-scope repo and PR:
handled/pending counts by category, build/test status (including `n/a`),
commit hash, push/reply status, and failures. Label completed entries
merged using their available PR identity. Name every **ORPHANED** PR and
the need for a human to close or merge it. Never report success from just
one repo's result. This becomes `priorContext` for the next code review.

After all usable entries have been processed, make one routing/exit
decision. Take the first case that applies:

1. **The set is incomplete** (Step 1). Name every missing input and route
   once to coding:

   ```
   redqueen issue set-phase "${issueId}" coding
   ```

   Check the exit code: exit 0 only if it succeeds; otherwise exit non-zero
   with a phase-change error. The explicit phase change lets the
   orchestrator dispatch the coder.

2. **Any repo remains blocked, failed, or has unhandled feedback.** Include
   those causes and exit non-zero for the existing feedback retry or
   escalation behavior. Do not let successful siblings advance the set.
3. **Everything succeeded.** Exit 0 only when feedback on every unfinished
   in-scope PR was handled successfully, including required build/test,
   push, and replies.

## Blocked path

Blocked applies per repo. Trigger it for the affected repo when:

- Git conflict on push (its feature branch diverged from `repo_base` in a
  non-mechanical way).
- Build or test failure in its worktree rooted in infrastructure (missing
  migration, unavailable external service).

Steps:

1. Post a PR comment with the blocking details, only to the affected repo's
   unfinished active PR, via:

   ```
   redqueen pr review "${repo_pr_number}" --repo "${repo_name}" --verdict request-changes
   ```

2. Record the blocker — "Blocked — <reason>." — and any review failure by
   repo.
3. Continue safe work on siblings.
4. Include all blocked repos, completed work, and orphan notices in Step
   10's set summary, then make its single final routing/exit decision.

## Important rules

- Reply to every comment. Partial replies confuse the reviewer.
- Be concise but complete in replies.
- If feedback suggests a fundamentally different approach from the spec,
  do not quietly pivot. Reply noting the divergence and flag it for human
  decision — the spec is the contract.
- Keep commits atomic — one commit per repo per feedback round, not per
  comment.
- The goal is to resolve the feedback so the PR can be re-reviewed, not to
  perfect the code beyond the feedback.
- **Standard markdown only in tracker replies.** PR comments and issue
  comments render as markdown. Use backticks, `**bold**`, `- bullet`,
  `[text](url)`. Never emit Jira wiki syntax (`{{text}}`, `{code}…{code}`,
  `h1.`).
