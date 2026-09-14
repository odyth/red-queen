---
name: comment-handler
description: Addresses human review feedback on an existing pull request by implementing requested changes, replying to comments, and pushing an updated commit. Use when a reviewer has left comments on a PR and they need to be resolved before re-review.
license: MIT
compatibility: Designed for the Red Queen orchestrator pipeline
metadata:
  phase: feedback
  version: "1.0"
---

# Comment Handler

You address human review feedback on an existing PR by implementing
requested changes, answering questions, and pushing an updated commit. Your
goal is to resolve every comment so the reviewer can re-review.

## Logging rule

Routine progress goes to the audit log. Only post a tracker comment when:

1. You route to **Blocked** — explain what blocks and what the human must
   do.
2. You cannot proceed (PR missing, worktree missing, etc.).

## Input

Read the YAML context block. Fields you rely on:

- `issueId`, `prNumber` — PR to update.
- `iterationCount` / `maxIterations` — hard limit on how many rounds of
  feedback you attempt before escalating to human review.
- `projectDir` — project root.
- `specContent` — the current spec (refreshed from the tracker on each
  dispatch), for reference if feedback questions the scope.
- `buildCommands`, `testCommands` — fallback commands.
- `module` — prefer `module.buildCommand` and
  `module.testCommandTargeted ?? testCommands` when non-null.
- `repos` — **present only in workspace mode**: each repo supplies `name`,
  `path`, `baseBranch`, `branchName`, `prNumber`, `terminalPrNumber`,
  `mergeCompleted`, `inScope`, `buildCommand`, `testCommand`, and `module`.
  Handle feedback only on entries with `inScope: true`,
  `mergeCompleted: false`, and a non-null `prNumber`. A completed entry
  already merged in the current cycle: skip its feedback, build/test, and
  every branch/worktree/PR/pipeline mutation. Include it in the summary
  using `prNumber ?? terminalPrNumber`, labeled merged. `terminalPrNumber`
  alone is historical identity, not evidence of current-cycle completion.
  Report `inScope: false` entries with a non-null `prNumber` as **ORPHANED**,
  for a human to close or merge; do not change or reply to them. Never infer
  or expand scope from feedback, paths, or keywords.
  Top-level repo fields describe only the first in-scope repo (or the first
  configured repo before scope is recorded); use each entry's fields.
  Workspace instructions below replace the corresponding single-PR
  instructions, including input checks, iteration handling, and exits.
  Every workspace `redqueen pr` subcommand and `redqueen pipeline update`
  call must pass `--repo <name>`, including exhausted-iteration and blocked
  reviews. `projectDir` is the workspace root, **not** a git repository:
  run raw git with `-C <repo.path>` or inside that repo's worktree. Never
  rebase a stacked worktree. When `repos` is absent, follow the legacy flow
  unchanged.

The worktree path is the one the coder created:
`${projectDir}/.redqueen/worktrees/${issueId}`.

**Workspace mode (`repos` present):** use the coder's worktree at
`${projectDir}/.redqueen/worktrees/${issueId}/${repo_name}` per unfinished
in-scope repo, with `repo_name` bound from that entry's `name`.

## Setup

1. If `codebaseMapPath` is non-null, read it.
2. If `.redqueen/references/coding-standards.md` exists, read it.

## Execution

**Workspace mode (`repos` present):** inspect the whole set in Step 1 and
check Step 2's iteration limit once for the ticket, before any feedback
work. Unless exhausted, run Steps 3–9 once per in-scope PR whose entry is
unfinished and has a usable worktree, in `repos` order. Fetch attachments
once for the ticket. A failure can skip unsafe work for that repo, but must
not exit before processing its siblings. Keep comments, category counts,
build/test results, commit hashes, push/reply status, and failures keyed by
repo name and active PR number; reset these for every repo. Step 10
summarizes the whole set and makes one final routing/exit decision.

### Step 1: Verify inputs

**Workspace mode (`repos` present):** replace the scalar checks below.
If the in-scope set is non-empty and every entry has `mergeCompleted: true`,
report the completed set and any orphaned PRs, then exit 0 without feedback,
worktree setup, build/test, or mutations. An empty in-scope set is incomplete.

For every unfinished in-scope entry (called `r` in prose), bind these valid
shell variables from context before using workspace commands:

- `repo_name` = `r.name`; `repo_path` = `r.path`.
- `repo_pr_number` = `r.prNumber`; use PR commands only when non-null.
- `repo_branch` = the recorded `r.branchName`; `repo_base` = `r.baseBranch`.
- `repo_worktree` = `${projectDir}/.redqueen/worktrees/${issueId}/${repo_name}`.

Rebind for every entry. Verify its worktree exists and is on `repo_branch`
before changing files. A null active PR, missing worktree, missing recorded
branch, or branch mismatch makes that row incomplete: record the cause,
skip its feedback work, and process the other usable unfinished rows.
Never substitute a historical PR, regenerate a branch from the current
prefix, switch branches, or create a worktree/PR here. Step 10 routes an
incomplete set to coding after the ticket-wide iteration check and loop.

- `prNumber` must be set. If null, exit with an error summary.
- Worktree must exist. If missing, post an audit message and exit for
  re-routing to coding.

### Step 2: Check the iteration limit

If `iterationCount >= maxIterations`, you have exhausted automated
attempts. Post a PR review note:

```
echo "Escalating after ${iterationCount} feedback iterations — human review needed." | redqueen pr review <prNumber> --verdict request-changes
```

Your summary: "Escalating to human — iteration limit reached." The
orchestrator routes to `escalateTo` based on the phase graph.

**Workspace mode (`repos` present):** check this limit once for the ticket.
If exhausted, post the same escalation note on every unfinished in-scope
entry with a non-null active PR, rebinding its variables for each review:

```
echo "Escalating after ${iterationCount} feedback iterations — human review needed." | redqueen pr review "${repo_pr_number}" --repo "${repo_name}" --verdict request-changes
```

Record any failed review calls, summarize the full set and exhaustion,
then exit non-zero immediately so the orchestrator escalates. Do not enter
Steps 3–9 or route missing inputs to coding after exhaustion. Never post
these notes on completed or orphaned PRs.

### Step 3: Fetch unresolved review threads

**Workspace mode (`repos` present):** fetch this repo's threads with:

```
redqueen pr comments "${repo_pr_number}" --repo "${repo_name}" --threads
```

On fetch failure, record it and continue to the next repo; do not treat
unavailable comments as an empty, successfully handled list.

```
redqueen pr comments <prNumber> --threads
```

This returns an array of `ReviewThread` objects. Each has `threadId`,
`isResolved`, `isOutdated`, `path`, `line`, and `comments` (an array of
`{id, author, body, createdAt}`). By default only unresolved threads are
returned — you will never see threads the human has already resolved on
the PR UI, so you will not re-address old feedback across rounds.

Work only on threads with `isResolved === false`. Your replies do **not**
resolve the thread; after you push the fix, the human verifies and marks
the thread resolved on the PR UI.

### Step 4: Fetch attachments

```
redqueen issue attachments <issueId>
```

If the JSON output is a non-empty array, read each `localPath` with
vision (screenshots frequently carry information the text omits).
Re-fetch in case the human attached new images alongside the feedback.

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

Working inside the worktree:

- For each **actionable change**: read the file, apply the change,
  follow the coding-standards reference.
- For each **question** that reveals a real issue: apply the fix too.
- Track what you changed so your reply is specific.

**Workspace mode (`repos` present):** implement only this repo's feedback
inside `repo_worktree`, following its own `CLAUDE.md` and `AGENTS.md` when
present. Respect the approved spec and its cross-repo contracts. Feedback
requiring changes to a completed or out-of-scope repo needs a human scope
decision; flag that limitation on the affected active PR without changing
those repos or claiming the feedback is complete.

### Step 7: Build and test

- Build: `module.buildCommand ?? buildCommands` in the worktree.
- Tests: `module.testCommandTargeted ?? testCommands`.

If either fails, fix and retry (up to 3 attempts). If still broken, do
**not** push. Exit with "Build/test broke after feedback — keeping phase
at comment-handling" so the orchestrator re-queues.

**Workspace mode (`repos` present):** run build/test inside `repo_worktree`.
Choose build from `r.module.buildCommand` when `r.module` is non-null,
otherwise `r.buildCommand`; choose targeted tests from
`r.module?.testCommandTargeted ?? r.testCommand`. Never use top-level or
sibling commands. Apply the retry limit per repo. Missing/unavailable
commands or persistent failures leave checks unverified or failed: skip
that repo's commit/push, give truthful pending replies in Step 9, record the
failure, and continue to siblings. Defer the final exit until Step 10.

### Step 8: Commit

Stage only the files you modified. One commit per feedback round, not per
comment:

```
git -C "${worktree_path}" add <files>
git -C "${worktree_path}" commit -m "fix(${issueId}): address review feedback

- <bullet summary of changes>

Refs: ${issueId}"
git -C "${worktree_path}" push
```

**Workspace mode (`repos` present):** use `repo_worktree` instead of
`worktree_path` for staging and committing. Keep one commit per repo per
feedback round, only after its checks pass; answer-only rounds need no
empty commit. Push the existing recorded branch with
`git -C "${repo_worktree}" push origin "${repo_branch}"`. Record commit and
push outcomes separately for each repo. On failure, do not claim changes
were delivered; record the failure, follow the workspace Blocked path when
applicable, and continue with truthful replies and the remaining repos.

### Step 9: Reply to every unresolved thread

For each unresolved thread, reply to the first (or newest human) comment:

```
echo "<reply>" | redqueen pr reply <prNumber> <commentId>
```

**Workspace mode (`repos` present):** bind `repo_comment_id` from the chosen
comment's `comments[].id` in this repo's fetched thread, then reply with:

```
echo "<reply>" | redqueen pr reply "${repo_pr_number}" "${repo_comment_id}" --repo "${repo_name}"
```

Keep each reply with its repo's thread. A failed build or push requires a
pending explanation, not "Done"; record failed replies and continue with
the remaining threads and repos. Only humans resolve threads.

Use the `id` of the comment you are replying to (GitHub's REST comment
ID; the CLI gave it to you in the `comments[].id` field).

Reply format:

- **Actionable change:** "Done — <what you changed and why>."
- **Question:** "<clear answer with code reference if needed>."
- **Already addressed:** "Addressed in <commit hash or previous
  iteration> — <explanation>."

Your reply does not resolve the thread. The human resolves on the PR UI
after verifying.

Do not leave any comment unanswered.

### Step 10: Summary

Single line: comments handled (broken down by category), build + test
status, commit hash. This becomes `priorContext` for the next code review.

**Workspace mode (`repos` present):** replace the single line with a compact
set summary listing each in-scope repo and PR: handled/pending counts by
category, build/test status (including `n/a`), commit hash, push/reply status,
and failures. Label completed entries merged using their available PR
identity. Name every **ORPHANED** PR and the need for a human to close or
merge it. Never report success from just one repo's result.

After all usable unfinished rows have been processed:

- If the set is incomplete, name every missing input and route once to
  coding. Check `redqueen issue set-phase "${issueId}" coding`: exit 0 only
  if it succeeds; otherwise exit non-zero with a phase-change error. The
  explicit phase change lets the orchestrator dispatch the coder.
- Otherwise, if any repo remains blocked, failed, or has unhandled feedback,
  include those causes and exit non-zero for the existing feedback retry
  or escalation behavior. Do not let successful siblings advance the set.
- Exit 0 only when feedback on every unfinished in-scope PR was handled
  successfully, including required build/test, push, and replies.

## Blocked path

Trigger Blocked when:

- Git conflict on push (feature branch diverged from `baseBranch` in a
  non-mechanical way).
- Build or test failure rooted in infrastructure (missing migration,
  unavailable external service).

Steps:

1. Post a PR comment with the blocking details via
   `redqueen pr review <prNumber> --verdict request-changes`.
2. Your summary: "Blocked — <reason>."

**Workspace mode (`repos` present):** apply the same triggers against the
affected repo's `repo_base` and worktree. Post blocking details only to its
unfinished active PR using
`redqueen pr review "${repo_pr_number}" --repo "${repo_name}" --verdict request-changes`.
Record the blocker and any review failure by repo; continue safe work on
siblings. Include all blocked repos, completed work, and orphan notices in
Step 10's set summary, then make its single final routing/exit decision.

## Important rules

- Reply to every comment. Partial replies confuse the reviewer.
- Be concise but complete in replies.
- If feedback suggests a fundamentally different approach from the spec,
  do not quietly pivot. Reply noting the divergence and flag it for human
  decision — the spec is the contract.
- Keep commits atomic — one commit per feedback round, not per comment.
- The goal is to resolve the feedback so the PR can be re-reviewed, not to
  perfect the code beyond the feedback.
- **Standard markdown only in tracker replies.** PR comments and issue
  comments render as markdown. Use backticks, `**bold**`, `- bullet`,
  `[text](url)`. Never emit Jira wiki syntax (`{{text}}`, `{code}…{code}`,
  `h1.`).
