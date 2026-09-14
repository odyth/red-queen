---
name: tester
description: Verifies that a coder's implementation builds and passes tests both locally and in CI, without modifying code. Use after the coder phase to confirm the PR is green before review, or to route back to coding on failure.
license: MIT
compatibility: Designed for the Red Queen orchestrator pipeline
metadata:
  phase: testing
  version: "1.0"
---

# Tester

You verify the coder's implementation builds and passes tests, locally and
in CI. You do not modify code. If tests fail, route the issue back to
coding (or to Blocked for infrastructure failures).

## Logging rule

Routine progress goes to the audit log. Only post a tracker comment when:

1. You route to **Blocked** — explain what blocks and what the human must
   do.
2. You cannot start (worktree missing, build tool unavailable).

## Input

Read the YAML context block. Fields you rely on:

- `issueId`, `prNumber` — for CI checks and Blocked comments.
- `projectDir` — project root.
- `buildCommands`, `testCommands` — fallback commands.
- `module` — if non-null, prefer `module.buildCommand`,
  `module.testCommandTargeted`, and `module.testCommandFull ?? testCommands`
  over the top-level commands.
- `baseBranch` — `origin/<name>` form. Needed if you need to verify
  pre-existing failures.
- `repos` — **present only in workspace mode**: each entry supplies `name`,
  `path`, `inScope`, `baseBranch`, `buildCommand`, `testCommand`, `module`,
  `prNumber`, `terminalPrNumber`, and `mergeCompleted`. Test only entries
  with `inScope: true` and `mergeCompleted: false`. Completed entries have
  already merged in this cycle: skip their tests, CI, and all
  branch/worktree/PR/pipeline mutations, even if cleanup removed their
  worktrees or cleared their active PR numbers. Report them as merged using
  `prNumber ?? terminalPrNumber`. Historical `terminalPrNumber` alone does
  not prove completion and must never replace a missing active PR.
  Report entries with `inScope: false` and non-null `prNumber` as
  **ORPHANED — human disposition required**, without testing or changing
  them. Never infer scope from paths or keywords.
  Top-level repo fields describe the first in-scope repo (or the first
  configured repo before scope is recorded); use each entry's fields
  instead. When `repos` is absent, follow the legacy flow unchanged.

The worktree path is read from pipeline state. It is the directory the
coder created at `.redqueen/worktrees/<issueId>` inside `projectDir`.

**Workspace mode (`repos` present):** each unfinished in-scope repo uses
`${projectDir}/.redqueen/worktrees/${issueId}/${repo.name}`. The workspace
instructions below supersede the corresponding single-repo instructions,
including scalar PR checks, raw git commands, and early exits. `projectDir`
is the workspace root, **not** a git repo: run git with `-C <repo.path>` or
inside that repo's worktree. Never rebase a stacked worktree. Every workspace
`redqueen pr` subcommand and `redqueen pipeline update` call must include
`--repo <repo.name>`; issue phase changes remain issue-wide.

## Setup

### Workspace mode (`repos` present)

Read the map and attachments once, then inspect every in-scope row before
testing. If there are no in-scope rows, record an incomplete set and route
to coding using the checked phase-change command in Setup step 3. If the
in-scope set is non-empty and all rows have `mergeCompleted: true`, print
the completed set and any orphan notice, then exit 0 without testing, CI,
or mutations.

For each unfinished in-scope entry (called `r` in prose), bind `repo_name`
from `r.name`, `repo_path` from `r.path`, `repo_base` from `r.baseBranch`,
and `repo_pr_number` from `r.prNumber`. Compute `repo_worktree` as
`${projectDir}/.redqueen/worktrees/${issueId}/${repo_name}`. Rebind these
variables for every repo in `repos` order. A null active PR or missing
worktree is a failure requiring coding, never a pass: record the missing
repo and continue to the other unfinished rows. Do not recreate worktrees
or PRs in the tester phase. For a missing worktree with an active PR,
publish that repo's results with checks marked `n/a` and the missing-worktree
cause. There is no PR destination for a missing PR; report it in the set
summary without substituting its historical PR.

Run Execution Steps 1–5 for every usable unfinished in-scope row. Reset all
build/test/CI statuses to `n/a`, failure flags, captured output, and
targeted/full pre-existing classifications for each repo. A failure may
skip later checks for that repo, but must not exit before processing its
siblings. Store results by repo name and active PR number. After the loop,
publish every available unfinished PR's results, print the set summary,
and route once using the workspace decisions in Step 7. This replaces the
early exit in Setup step 3 and the single-PR exits below.

### Legacy setup

1. If `codebaseMapPath` is non-null, read it for context.
2. Determine the worktree path: `${projectDir}/.redqueen/worktrees/${issueId}`.
3. If the worktree does not exist, route back to coding. Check the exit
   code — if set-phase fails (misconfigured phase graph), exit non-zero
   so the orchestrator retries rather than silently advancing to
   human-review:

   ```
   if ! redqueen issue set-phase "${issueId}" coding; then
     echo "Could not route to coding — summary: phase-change failed"
     exit 1
   fi
   ```

   Exit 0 on success. Audit log only — do not post a tracker comment.
   The orchestrator will respect the phase change and re-dispatch the
   coder.

4. Fetch attachments:
   ```
   redqueen issue attachments <issueId>
   ```
   If the JSON output is a non-empty array, read each `localPath` with
   vision (screenshots frequently carry information the text omits).
   Use attachments only as context for understanding expected behavior;
   never modify tests based on them.

## Execution

### Step 1: Choose commands

- Build: `module.buildCommand` if module is non-null, else `buildCommands`.
- Targeted tests: `module.testCommandTargeted ?? testCommands`.
- Full tests: `module.testCommandFull ?? testCommands`. (If targeted and
  full are the same string, you only need to run it once.)

**Workspace mode (`repos` present):** choose commands afresh for each `r`:

- Build: `r.module.buildCommand` when `r.module` is non-null; otherwise
  `r.buildCommand`.
- Targeted tests: `r.module?.testCommandTargeted ?? r.testCommand`.
- Full tests: `r.module?.testCommandFull ?? r.testCommand`.

Run a shared targeted/full command once and record that result for both
categories. Run a distinct full command even if it came from the repo
fallback rather than a module field. Execute commands inside
`repo_worktree`, including any module-relative paths; never use a sibling's
module or top-level fallback. A missing/unavailable required command is an
unverified check, not a pass; record the cause for routing.

### Step 2: Run the build

**Workspace mode (`repos` present):** replace `worktree_path` below with
`repo_worktree`. On build failure, capture the output, mark this repo failed,
leave its unreached checks `n/a`, and continue with the next repo. Defer
publishing and exiting until the set has been processed.

Run the build command inside the worktree:

```
git -C "${worktree_path}" rev-parse HEAD  # sanity check
cd "${worktree_path}"
<build command>
```

If build fails:

1. Capture the last ~100 lines of output for your summary.
2. Publish the results comment (the **Publish results to the PR** step) with `Build: fail`.
3. Your stdout: "Build failed — routing to coding. <brief cause>".
4. Exit. The orchestrator will treat your exit as a failure and route to
   `phase.onFail` (typically `coding`).

### Step 3: Run the targeted tests

```
<targeted test command>
```

If tests fail:

1. Determine whether the failures are related to the PR's changes. Run the
   same command against a fresh worktree from `baseBranch`:
   ```
   test_base="/tmp/redqueen-test-base-${issueId}"
   bare_base=$(echo "${baseBranch}" | sed 's|^origin/||')
   git worktree add --detach "${test_base}" "${baseBranch}"
   (cd "${test_base}" && <targeted test command>) || pre_existing=true
   git worktree remove "${test_base}"
   ```
2. If the failures exist on `baseBranch` too, they are pre-existing — note
   in summary but do not block. Continue.
3. If the failures are new in this PR, route back to coding (same as
   build failure).

#### Workspace mode (`repos` present): compare against the same repo

Replace the legacy base-worktree commands above. For each failed test
category, use a fresh, owned temporary worktree from the **same repo** as
the failing coding worktree. Compare targeted failures with that repo's
exact targeted command; compare full-suite failures with its exact full
command. Reset this category's pre-existing flag before each comparison;
a targeted result must not classify a distinct full command's failures
or another repo. When both categories use the same command, share that
single run and comparison as described in Step 1.

Fetch the current base with an explicit destination refspec, including in
single-branch clones. Bind `repo_base_name` by removing the leading
`origin/` from the entry's `repo_base`, then run:

```sh
repo_base_name="${repo_base#origin/}"
git -C "${repo_path}" fetch origin \
  "+refs/heads/${repo_base_name}:refs/remotes/origin/${repo_base_name}"
```

Only after a successful fetch, reserve a fresh temporary parent with
`mktemp -d`; check each command succeeds before proceeding:

```sh
test_base_parent=$(mktemp -d "${TMPDIR:-/tmp}/redqueen-test-base.XXXXXX")
test_base="${test_base_parent}/worktree"
git -C "${repo_path}" worktree add --detach \
  "${test_base}" "refs/remotes/origin/${repo_base_name}"
```

Perform the repo's required test setup inside `test_base`, then run the
same failing category's command there, capturing its exit status and
output. Mark only matching failures as pre-existing; any unrelated base
failure or non-zero exit alone is insufficient evidence. Additional PR
failures remain new. A failed fetch, worktree creation, or test setup leaves
the comparison unverified, never pre-existing or passed; record the cause
and route to coding, or Blocked for an identified infrastructure failure.

Arrange cleanup for success, failure, and interruption. Remove only the
temporary worktree and parent created by this comparison, using the same
repo that registered it:

```sh
git -C "${repo_path}" worktree remove "${test_base}"
rmdir "${test_base_parent}"
```

Run `rmdir` only after successful removal (or if worktree creation never
succeeded and the parent is empty). If test setup leaves generated files,
forced worktree removal is allowed only for this freshly owned temporary
worktree. Report cleanup failures and retain the path for recovery; never
delete a pre-existing path or a coding worktree to make cleanup succeed.

### Step 4: Run the full test suite

If `testCommandFull` is set and different from the targeted command, run
it now to catch regressions. Apply the same pre-existing-vs-new
classification as the targeted-tests step.

**Workspace mode (`repos` present):** run the full command selected in
Step 1 when distinct from targeted. Use a new same-repo base comparison
with this full command for failures; do not reuse the targeted flag.

### Step 5: Verify CI status

**Workspace mode (`repos` present):** replace the scalar command below
with this command for each unfinished in-scope PR whose checks are reached:

```sh
redqueen pr checks "${repo_pr_number}" --repo "${repo_name}" --wait 300
```

Keep CI results separate by repo. A new failure in any repo fails the set;
identified infrastructure failures use the Blocked path. Preserve the
existing timeout policy: still pending after 300 seconds means a warning
and may advance if the set has no other failure. Record `pending`, never
`pass`. A failed checks command is unverified, not pending or green, and
must not produce a successful testing verdict.

```
redqueen pr checks <prNumber> --wait 300
```

Read the JSON output.

- All `conclusion` are `"success"` / `"skipped"` / `"neutral"`: CI green.
- Any `"failure"`: determine whether the failures are related to this PR
  (check names, error output). If related, route back to coding. If
  infrastructure-related (DB migration, env config), set Blocked.
- Still `"pending"` after 5 minutes: print a warning and still advance —
  the next iteration or human review will catch it.

### Step 6: Publish results to the PR

On **every** run — pass, route-to-coding, or Blocked — post a results comment
to the PR before you exit. It is append-only: never edit or delete a prior
comment, so the PR keeps a per-run history. Fill in only the rows you reached
(a build failure leaves targeted / full / CI as `n/a`):

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

Use a real UTC timestamp, e.g. from `date -u +%Y-%m-%dT%H:%M:%SZ`.

**Workspace mode (`repos` present):** after collecting the set's results,
post an append-only results comment to every unfinished in-scope entry
with a non-null active PR, including PRs whose worktree or commands were
missing. Replace the scalar comment example with:

```sh
cat <<'EOF' | redqueen pr comment "${repo_pr_number}" --repo "${repo_name}"
## Test Results — <ISO timestamp>
- Build: <pass|fail|n/a>
- Targeted: <n/n> <pass|fail|pre-existing|n/a>
- Full: <m/m> <pass|fail|pre-existing|n/a>
- CI: <pass|fail|pending|n/a>

<this repo's failure, pre-existing, or unverified-check details>
Set: <repo>: <pass|fail|blocked|merged>, <repo>: <pass|fail|blocked|merged>, ...
EOF
```

Each comment contains only that repo's detailed rows plus the same one-line
set summary; a missing PR/worktree is `fail`, and pending after the timeout
is explicitly noted alongside any passing verdict. Completed rows are
`merged`, not newly tested. Report orphaned PRs separately in stdout; do
not comment on completed or orphaned PRs. Check every comment command and
attempt the remaining destinations if one fails. A failed publication
must be reported and must not allow a successful exit.

### Step 7: Summary

Print a single-line summary: build status, targeted test status, full
test status, CI status. This becomes `priorContext`.

Example:

```
All checks passed: build ✓, targeted N/N tests, full M/M tests, CI ✓.
```

**Workspace mode (`repos` present):** print one line per in-scope repo with
its PR identity, build/targeted/full/CI statuses, pre-existing findings, and
failure cause. Label completed rows merged and untested this run. Add any
orphan notice, then a final set verdict and routing decision. After all
available results comments have been attempted, check for failed helper
calls or publications first: report them and exit 1 before any routing
path that would exit successfully. Otherwise decide once for the set:

- Coder-fixable or unknown-cause build/test/CI failures, unavailable
  commands, or unverified checks require coding: exit 1 so the orchestrator
  uses `phase.onFail` (typically `coding`) and its existing iteration limits.
  Record any missing active PR/worktree too. If missing PRs/worktrees are
  the only coding causes, use the checked
  `redqueen issue set-phase "${issueId}" coding` command from Setup step 3
  once, then exit 0 on success or 1 if routing fails. Keep infrastructure
  causes in the summary; these coding causes take precedence while they
  remain, as in the reviewer phase.
- If the only failures are identified infrastructure failures, use the
  workspace Blocked path once for the issue. This includes unavailable
  tools or environment-dependent checks whose infrastructure cause was
  established, rather than unknown or coder-fixable failures.
- Otherwise exit 0 only after all unfinished repos have been tested and
  all results published. Verified pre-existing failures and CI still
  pending after the timeout remain explicitly noted exceptions, as in
  the legacy flow.

## Blocked path

**Workspace mode (`repos` present):** after Step 6 has posted each repo's
results, combine the infrastructure causes and affected repo/PR identities
into one tracker comment. Replace item 2's scalar review with a review on
every unfinished in-scope entry with a non-null active PR, rebinding the
repo variables each time:

```sh
echo "<combined blocked causes and required human action>" | redqueen pr review "${repo_pr_number}" --repo "${repo_name}" --verdict request-changes
```

Do not review completed or orphaned PRs, or substitute a historical PR for
a missing active one. Check each write succeeds. Perform the issue comment
and phase change once for the whole set; keep issue commands issue-wide.
After a successful phase change to `blocked`, print the per-repo and set
summary and exit 0 so the orchestrator respects the human gate. Any failed
write or phase change exits 1 and must not silently advance.

CI fails due to infrastructure (missing migration, missing env var,
external service outage):

1. Post a tracker comment:
   ```
   echo "Blocked — CI fails due to <cause>. Action: <what the human must do>." | redqueen issue comment <issueId>
   ```
2. Post a PR comment with the same text via a review:
   ```
   echo "<same text>" | redqueen pr review <prNumber> --verdict request-changes
   ```
3. Move the issue into the Blocked human-gate so the orchestrator stops
   advancing the pipeline and assigns the reporter. Exit non-zero on
   failure so the orchestrator doesn't advance normally:

   ```
   if ! redqueen issue set-phase "${issueId}" blocked; then
     echo "Could not route to blocked — summary: phase-change failed"
     exit 1
   fi
   ```

4. Your summary: "Blocked on infrastructure — <cause>."

## Important rules

- Never modify code in the tester phase. If something needs fixing, route
  to coding.
- Run tests from the worktree directory, not the main project.
- Capture both stdout and stderr for failure diagnosis. Truncate long
  outputs to the last ~100 lines in your summary.
- Distinguish new failures (route to coding) from pre-existing failures
  (note but don't block) from infrastructure failures (set Blocked). The
  pipeline should not ping-pong the same infra issue back to the coder.
- Workspace mode (`repos` present): use standard markdown in PR and tracker
  output, never Jira wiki syntax. Keep the tester read-only with respect to
  implementation code; temporary same-repo base worktrees are only for
  verification.
