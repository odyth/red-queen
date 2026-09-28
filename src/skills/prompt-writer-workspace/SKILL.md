---
name: prompt-writer-workspace
description: Writes or revises an implementation specification for an issue in a multi-repo workspace and records which repos are in scope, producing the single source of truth a downstream coder agent will use. Use during spec-writing or spec-feedback phases in a workspace install when an issue needs to be turned into an actionable, self-contained spec with per-repo file paths, method names, and acceptance criteria.
license: MIT
compatibility: Designed for the Red Queen orchestrator pipeline (multi-repo workspace installs)
metadata:
  phase: spec-writing
  version: "1.0"
---

# Prompt Writer

You are writing an implementation specification that a separate coder agent
will use as its single source of truth. The coder will not see the issue
description, comments, or your exploration — every file path, method name,
and acceptance criterion must appear in the spec.

This install is a multi-repo workspace. One issue can change several
repositories, and you are the only skill that decides which of them an issue
touches: you choose the scope, name it in the spec's **Repos in Scope**
section, and record it with `redqueen spec meta … --repos`. Only the repos
you include will be coded, reviewed, and tested for this ticket.

## Logging rule

Routine progress goes to the orchestrator's audit log automatically — your
final summary (the last paragraph you print) is recorded as `priorContext`
for the next phase. **Only** post a tracker comment (via
`redqueen issue comment`) in these cases:

1. You are setting the issue to **Blocked** — explain what is blocking and
   what the human must do to unblock.
2. You cannot write the spec because the issue is too vague — explain what
   is unclear and what information is needed.

Keep tracker comments concise and actionable. Humans see them.

## Input

Read the YAML context block at the top of this prompt. Fields you rely on:

- `issueId` — the issue key to read and write.
- `phaseName` — branches your behavior:
  - `spec-writing` → **Fresh Write Flow** (below).
  - `spec-feedback` → **Revision Flow** (below).
- `projectDir` — absolute path to the workspace root. It is **not** a git
  repository. Each repo's spec worktree lives at
  `${projectDir}/.redqueen/worktrees/spec-${issueId}/<repo.name>`.
- `specContent` — `null` on fresh write, populated on revision.
- `codebaseMapPath` — path to the workspace map when present.
- `stackBlockedBy` — **present only on stacked issues**: ids of the issues
  this one is blocked by. When present, create the exploration worktrees via
  `redqueen stack setup --spec` (Fresh Write Flow Step 4, reused by Rev
  Step 3) so ancestor branches are included, and write the spec against that
  combined state.
- `repos` — every configured repo as
  `{name, path, baseBranch, buildCommand, testCommand, inScope, branchName,
prNumber, terminalPrNumber, mergeCompleted, module}`. `path` is the repo's
  absolute checkout path. Before scope is first recorded, every repo has
  `inScope: false`; on revision, these flags reflect the previously recorded
  scope. You choose scope and publish it with
  `redqueen spec meta … --repos` (Fresh Write Flow Step 8, Rev Step 7).

Rules that hold for every step:

- Ignore the top-level `baseBranch`, `buildCommands`, `testCommands`,
  `repoOwner`, `repoName`, `module`, `branchName`, `prNumber`, and
  `stackPrBase`. They describe a single repo; use each `repos` entry's own
  fields.
- Run raw git with `-C <repo.path>` or inside that repo's spec worktree,
  never from the workspace root.
- Scope reads to each repo's `path` for orientation and then to its spec
  worktree.
- Never rebase a stacked worktree.

## Shared setup (both flows)

Before either flow, do these in order:

1. If `codebaseMapPath` is not null, read it. It is your architecture guide,
   with one `## Repo: <name>` section per repo.
2. If `.redqueen/references/spec-template.md` exists under `projectDir`,
   read it. Your spec follows that structure.
3. Fetch the issue:
   ```
   redqueen issue get <issueId>
   ```
   Parse the JSON. You care about `summary`, `status`, and `issueType`.
4. Fetch attachments:
   ```
   redqueen issue attachments <issueId>
   ```
   If the JSON output is a non-empty array, read each `localPath` with
   vision (screenshots frequently carry information the text omits).
   Write an **ATTACHMENT ANALYSIS** section in the spec describing what
   each image shows.
5. Identify the candidate repos: the repos the change could plausibly touch.
   Use the workspace map and the ticket context, and start generously. If
   the map or ticket context is insufficient, start with all repos as
   candidates.
6. For each candidate, explicitly read `<repo.path>/CLAUDE.md` and
   `<repo.path>/AGENTS.md` when present, at most about 200 lines each,
   before any grep. Do not rely on on-demand instruction loading for this
   orientation.

## Fresh Write Flow (`phaseName` = `spec-writing`)

### Step 1: Read the issue

The issue JSON from `redqueen issue get` is your input. Look at `summary`,
description (if present in the adapter's JSON), and any prior comments
fetched via `redqueen issue comments <issueId>`.

### Step 2: Assess clarity

The issue must describe what needs to change and include enough context to
identify the affected code. If it does not, route to awaiting info:

1. Post your questions so the reporter can answer in-thread:

   ```
   echo "<questions>" | redqueen issue comment <issueId>
   ```

2. Move the issue into the Awaiting Info human-gate. Check the exit
   code — if the phase is missing from the configured graph or the
   tracker rejects the call, `set-phase` exits non-zero:

   ```
   if ! redqueen issue set-phase <issueId> spec-awaiting-info; then
     echo "Could not route to spec-awaiting-info — summary: phase-change failed"
     exit 1
   fi
   ```

3. Exit 0 on success. The orchestrator respects the phase change and
   reassigns the ticket to the reporter. A non-zero exit lets the
   orchestrator retry or escalate rather than silently advancing.

Only use this route for "reporter can answer with a comment" questions.
For structural blockers (the change contradicts code reality,
infrastructure is missing, etc.), use the **When to set Blocked** path at
the bottom of this file instead — that is a different signal and keeps the
existing Blocked human-gate loop.

**Revision Flow does not route to awaiting-info.** When a reviewer
requests changes in `spec-feedback`, the input is disagreement, not
absence — revise the spec to reflect the new direction. If the reviewer's
feedback itself is unclear, follow the existing Blocked path.

### Step 3: Check for prior clarification responses

Fetch comments: `redqueen issue comments <issueId>`. If `priorContext`
references a prior awaiting-info handoff (your own previous summary will
name it), the newest reporter comments since that handoff are their
answers — fold them into your exploration before writing the spec. If you
still cannot find responsive answers despite the round trip, route back
to `spec-awaiting-info` with a pointed follow-up question rather than
guessing.

### Step 4: Create the exploration worktrees

Work against each repo's latest `baseBranch`, not its main checkout.

Prepare an exploration ("spec") worktree for **every** configured repo,
including repos outside the current candidates or previously recorded scope.
Run raw git from the selected repo or its worktree, never from the workspace
root.

For commands that operate on one entry of `repos`, bind the following shell
variables to that entry's literal context values, with proper shell quoting;
`projectDir` and `issueId` also come from the context. Rebind for each repo:

```sh
repo_name='<name>'
repo_path='<absolute path>'
repo_base='<baseBranch>'
repo_worktree="${projectDir}/.redqueen/worktrees/spec-${issueId}/${repo_name}"
bare_base="${repo_base#origin/}"
```

`repo_base` is in `origin/<name>` form; `bare_base` is that value with the
`origin/` prefix removed (e.g. `main` when `baseBranch` is `origin/main`).

**Stacked issue (`stackBlockedBy` present in the context):** the issue
builds on unmerged ancestor branches, so the exploration worktrees must
include them. Run:

```sh
redqueen stack setup "${issueId}" --spec
```

Inspect both its exit code and JSON:

- Exit 0 (`status: "ok"`) prepares a detached spec worktree for every repo at
  `${projectDir}/.redqueen/worktrees/spec-${issueId}/<repo.name>`. The JSON
  `repos` array lists the prepared worktrees and merged ancestor refs.
- Exit 2 (`status: "conflict"`) stops at the **first** conflicting repo. The
  JSON `repo` names it and `files` names the conflict files; `repos` contains
  only successfully prepared earlier repos. Preserve those worktrees and the
  conflicting repo's worktree, which contains base plus the ancestors merged
  cleanly before the aborted merge. For **every remaining, unattempted repo**,
  create or refresh a detached **base-only** worktree with the non-stacked
  procedure below, even if an old worktree already exists. Confirm every repo
  now has an exploration worktree. In **Risks & Pitfalls**, name the
  conflicted repo and files, the missing conflicting/later ancestor
  contributions there, and every base-only fallback repo whose ancestor
  contributions were not assembled. Treat these as exploration limits, not
  evidence that a repo is out of scope; retain uncertainty in Open Questions.
- Exit 3 (`status: "blocked"`) means unsatisfied dependencies or a stack
  configuration problem. Follow **When to set Blocked**, using the JSON
  `unsatisfied`, `problems`, and `cycle` details. Do not substitute base-only
  exploration for this dependency gate.
- Exit 1 (`status: "error"`) or any unexpected failure is an operational
  error. Report it in stdout and exit non-zero for retry or escalation. Do
  not treat it as a content conflict or continue with stale worktrees.

**Non-stacked issue (no `stackBlockedBy`):** for every repo, fetch its base
and create a detached spec worktree. This procedure also supplies the
base-only fallback for unattempted repos after a stacked content conflict:

```sh
git -C "${repo_path}" fetch origin "+refs/heads/${bare_base}:refs/remotes/origin/${bare_base}"
git -C "${repo_path}" worktree add --detach "${repo_worktree}" "${repo_base}"
```

If that repo's spec worktree already exists, refresh it instead:

```sh
git -C "${repo_path}" fetch origin "+refs/heads/${bare_base}:refs/remotes/origin/${bare_base}"
git -C "${repo_worktree}" checkout --detach "${repo_base}"
git -C "${repo_worktree}" reset --hard "${repo_base}"
```

Check each command succeeds before continuing; a setup failure must not lead
to exploration of a stale or missing path. Use these refresh commands only
for the disposable spec worktrees, never a repo checkout or coding worktree.

From here on, every Glob / Grep / Read that explores code is scoped to the
spec worktrees. A repo's main checkout may be on a different branch or have
uncommitted changes — using it would produce a misleading spec.

### Step 5: Explore the codebase

Grep only the candidate repos' spec worktrees. Use Glob / Grep / Read
against them to find:

- The module(s) affected by the change.
- Existing patterns and naming conventions in that area.
- Test files that need updating.

Drop candidates when the code proves them irrelevant. Add a previously
excluded repo only when code you read points to it, such as an endpoint,
event, or template reference; first read its `CLAUDE.md` and `AGENTS.md` as
in shared setup, then explore its spec worktree. The candidates that survive
this exploration become the ticket's scope.

### Step 6: Write the spec

Follow `.redqueen/references/spec-template.md` if present, or the structure
below otherwise. The spec must be self-contained — the coder sees only this
document.

Required sections:

- **Problem** — one paragraph on what needs to change and why.
- **Root Cause / Context** — the existing code area that plugs in.
- **Repos in Scope** — name every in-scope repo with one line explaining why
  it is touched, and every dropped candidate with one line explaining its
  exclusion. Clearly label inclusions and exclusions; only the included repos
  will be coded, reviewed, and tested for this ticket.
- **Files to Change** — exhaustive, concrete, with function / class names.
  Group files under a `### <repo.name>` heading for each in-scope repo. Spell
  out cross-repo contracts (endpoint shapes, event names, template
  references, shared config keys) and each repo's part so the changes can be
  implemented and reviewed together.
- **Implementation Steps** — numbered, atomic.
- **Test Plan** — each acceptance criterion maps to a verification step.
- **Non-Goals** — explicit out-of-scope items.
- **Open Questions** — checkbox list for the reviewer to resolve during
  spec review. If there are none, say so explicitly.
- **Risks & Pitfalls** — non-obvious traps for the coder.
- **Attachment Analysis** — omit if there are no attachments.

Include **Repos in Scope** and the per-repo **Files to Change** groups even
when the custom spec template omits them. Keep the named scope and planned
changes consistent.

### Step 7: Save the spec

```
cat <<'EOF' | redqueen spec set <issueId>
<spec body>
EOF
```

Use a HEREDOC to preserve formatting. The helper updates both the tracker
and the cached `specContent` in pipeline state.

### Step 8: Record the scope and open-question count

Count the items remaining in the spec's **Open Questions** section (after
you've tried to answer them yourself in Step 6). Then publish the count,
together with the scope, so the orchestrator can route — when
`pipeline.skipSpecReviewIfReady` is on and the count is zero, the
orchestrator skips the spec-review human gate and goes straight to coding.

```
redqueen spec meta <issueId> --open-questions <N> --repos <name>[,<name>…]
```

`<N>` is a non-negative integer. Always call this — pass `0` when the spec
has no open questions, or the actual count otherwise. Do not skip the call
to "force" the human gate; the orchestrator only skips when the project
opts in via config.

`--repos` is required. Pass exactly the repos marked **in scope** in the
spec's **Repos in Scope** section, comma-separated, using `name` values
copied from the context; omit dropped candidates. The helper rejects unknown
names and empty scope and records scope together with the open-question
count for all downstream skills. If exploration leaves no repo in scope, use
**When to set Blocked** instead of inventing scope. Check the command
succeeds before reporting completion.

### Step 9: Clean up the worktrees

Rebind `repo_path` and `repo_worktree` as in Step 4 for every entry of
`repos`, and remove each spec worktree from its owning repo, including
dropped candidates and base-only fallbacks:

```sh
git -C "${repo_path}" worktree remove "${repo_worktree}"
```

If a removal fails, retry it with `--force`. If it still fails, continue —
the next run will refresh the worktree. Preserve that worktree's directory
for the next run and mention the cleanup failure in the summary.

Then remove the parent directory **only if empty**:

```sh
rmdir "${projectDir}/.redqueen/worktrees/spec-${issueId}"
```

### Step 10: Final summary (your stdout)

Print one line summarizing what you produced. This becomes `priorContext`
for the next phase.

## Revision Flow (`phaseName` = `spec-feedback`)

### Rev Step 1: Read the current state

- `specContent` in the context block is the existing spec, refreshed by
  the orchestrator from the tracker before this dispatch — so inline
  human edits made on the spec custom field or marker comment during
  spec-review are already folded in. That is what you are revising.
- `priorContext` in the context block carries the summary of the
  spec-review human reviewer (or the previous spec-feedback iteration on
  multi-round reworks). Read it before anything else.
- Fetch comments: `redqueen issue comments <issueId>`. The most recent
  human feedback since the prior `priorContext` handoff is the changes
  to apply.
- Attachments may have changed — re-run `redqueen issue attachments` and
  re-read any new images.

### Rev Step 2: Analyze the feedback

For each point, classify it:

- **Diagnosis change** — the reviewer disagrees with the root cause.
- **Scope change** — files or acceptance criteria are added or removed.
- **Question answered** — the reviewer resolved an Open Question.
- **Clarification** — wording or structure needs adjustment.

### Rev Step 3: Refresh the worktrees

Create or refresh one spec worktree per configured repo the same way as
Fresh Write Flow Step 4, including the stacked-issue
`redqueen stack setup --spec` path, its conflict fallback, and its error
handling. Use the candidate-only exploration rules from Fresh Write Flow
Step 5.

### Rev Step 4: Re-verify everything against the current code

The codebase may have moved since the original spec. Re-verify file paths
and function names even for sections the feedback did not touch.

### Rev Step 5: Revise the spec

Produce a complete replacement spec. Do not leave "FEEDBACK:" markers or
track-changes annotations. Follow the same structure as the fresh-write
spec.

Re-evaluate **Repos in Scope** against the feedback and current code.
Feedback may add or drop repos. Read newly added candidates' instructions
before exploring them, and keep the scope section and per-repo **Files to
Change** groups consistent.

### Rev Step 6: Save the revised spec

```
cat <<'EOF' | redqueen spec set <issueId>
<revised spec>
EOF
```

### Rev Step 7: Record the scope and open-question count

Same as Fresh Write Flow Step 8, including its validation and empty-scope
handling — count remaining items in the spec's Open Questions section and
publish:

```
redqueen spec meta <issueId> --open-questions <N> --repos <name>[,<name>…]
```

Record the complete revised in-scope set. A dropped repo keeps any existing
branch or PR; `redqueen status` shows an outstanding PR as orphaned for a
human to close. Do not close its PR or delete its branch or coding worktree.

### Rev Step 8: Clean up and summarize

Remove the worktrees (same as Fresh Write Flow Step 9). Print a one-line
summary naming the main changes so the next review has context.

## When to set Blocked

If you cannot produce a usable spec after a reasonable exploration pass, do
not keep grinding.

1. Post a `redqueen issue comment` explaining what is blocking you, what
   you have tried, and what the human needs to provide.
2. Move the issue into the Blocked human-gate so the orchestrator stops
   advancing the pipeline and assigns the reporter. Exit non-zero if
   the set-phase call fails so the orchestrator doesn't advance
   normally:

   ```
   if ! redqueen issue set-phase <issueId> blocked; then
     echo "Could not route to blocked — summary: phase-change failed"
     exit 1
   fi
   ```

3. Your final stdout summary should say "Blocked — <reason>" so
   `priorContext` reflects it.

## Iteration limit

`iterationCount` and `maxIterations` are in the context block. On
`spec-feedback`, if `iterationCount >= maxIterations - 1`, this is your
last automated revision. State that in your summary so the reviewer knows
the next decision is theirs.

## Quality standards for the spec

- **Self-contained:** the coder never sees the issue description.
- **Specific:** every file, function, and symbol is named.
- **Testable:** every acceptance criterion has a verification step.
- **Scoped:** Non-Goals prevent scope creep.
- **Honest:** if you are uncertain, put it in Open Questions — do not guess.
- **Standard markdown only:** the tracker renders markdown — spec fields and
  comments. Use backticks (`` `code` ``) for inline code, triple-backtick
  fences for blocks, `**bold**`, `*italic*`, `- bullet`, `1. numbered`,
  `- [ ] / - [x]` for checkboxes, `[text](url)` for links. Do **not** emit
  Jira wiki syntax such as `{{monospaced}}`, `{code}…{code}`, `h1.`, `*bold*`
  (wiki bold), `||header||` tables, or `{{variable-style}}` placeholders —
  those render as literal garbage in modern Jira.

## Context isolation rules

- Do not write "as described in the ticket" or "as discussed above".
- Do not quote raw issue text unless strictly necessary.
- Every file path and function name you reference must exist in the spec
  worktree you explored for its repo.
