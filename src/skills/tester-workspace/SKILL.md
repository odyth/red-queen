---
name: tester-workspace
description: Verifies that a coder's implementation builds and passes tests both locally and in CI in every in-scope repo of a multi-repo workspace, without modifying code. Use after the coder phase in a workspace install to confirm every PR in the change-set is green before review, or to route back to coding on failure.
license: MIT
compatibility: Designed for the Red Queen orchestrator pipeline (multi-repo workspace installs)
metadata:
  phase: testing
  version: "1.0"
---

# Tester

You verify the coder's implementation builds and passes tests, locally and
in CI. You do not modify code. If tests fail, route the issue back to
coding (or to Blocked for infrastructure failures).

This install is a multi-repo workspace. One issue can change several
repositories; each repo it touches gets its own branch, worktree, and PR, and
those PRs form one change-set. You verify every unfinished in-scope repo,
then route once for the whole set.

## Logging rule

Routine progress goes to the audit log. Only post a tracker comment when:

1. You route to **Blocked** — explain what blocks and what the human must
   do.
2. You cannot start (worktree missing, build tool unavailable).

## Input

Read the YAML context block. Fields you rely on:

- `issueId` — the issue key. Used for worktree paths, phase changes, and
  Blocked comments.
- `projectDir` — absolute workspace root. It is **not** a git repository.
  Worktrees live under `${projectDir}/.redqueen/worktrees`.
- `repos` — every configured repo; each entry supplies `name`, `path`,
  `inScope`, `baseBranch`, `buildCommand`, `testCommand`, `module`,
  `prNumber`, `terminalPrNumber`, and `mergeCompleted`. `path` is the repo's
  absolute checkout path. `baseBranch` is in `origin/<name>` form, needed to
  verify pre-existing failures. `buildCommand` and `testCommand` are that
  repo's fallback commands. `module` is that repo's resolved module or null;
  when non-null, prefer its commands over the entry's fallback commands
  (Step 1).

How to treat each `repos` entry:

- **Unfinished in-scope** (`inScope: true`, `mergeCompleted: false`) — the
  only entries you test.
- **Completed** (`mergeCompleted: true`) — this repo already merged in the
  current cycle. Skip its tests, CI, and all branch/worktree/PR/pipeline
  mutations, even if cleanup removed its worktree or cleared its active PR
  number. Report it as merged using `prNumber ?? terminalPrNumber`.
  Historical `terminalPrNumber` alone does not prove completion and must
  never replace a missing active PR.
- **Orphaned** (`inScope: false` with a non-null `prNumber`) — report it as
  **ORPHANED — human disposition required**, without testing or changing
  it.
- Any other entry is not part of this issue. Leave it alone.

Never infer scope from paths or keywords.

Each unfinished in-scope repo's worktree is the directory the coder created
at `${projectDir}/.redqueen/worktrees/${issueId}/${repo.name}`.

Rules that hold for every step:

- Ignore the top-level `baseBranch`, `buildCommands`, `testCommands`,
  `module`, `branchName`, `prNumber`, and `stackPrBase`. They describe a
  single repo; use each `repos` entry's own fields.
- Every `redqueen pr` subcommand and every `redqueen pipeline update` call
  passes `--repo <name>`. Issue phase changes and other `redqueen issue`
  commands remain issue-wide.
- Run raw git with `-C <repo.path>` or inside that repo's worktree.
- Never rebase a stacked worktree.
- Do not recreate worktrees or PRs in the tester phase.
- Process repos in `repos` order.

## Setup

1. If `codebaseMapPath` is non-null, read it for context. Read it once for
   the whole set.
2. Fetch attachments once for the whole set:
   ```
   redqueen issue attachments <issueId>
   ```
   If the JSON output is a non-empty array, read each `localPath` with
   vision (screenshots frequently carry information the text omits).
   Use attachments only as context for understanding expected behavior;
   never modify tests based on them.
3. Inspect every in-scope entry before testing.

   If no entry has `inScope: true`, record an incomplete set and route back
   to coding. Check the exit code — if set-phase fails (misconfigured phase
   graph), exit non-zero so the orchestrator retries rather than silently
   advancing to human-review:

   ```
   if ! redqueen issue set-phase "${issueId}" coding; then
     echo "Could not route to coding — summary: phase-change failed"
     exit 1
   fi
   ```

   Exit 0 on success. Audit log only — do not post a tracker comment.
   The orchestrator will respect the phase change and re-dispatch the
   coder.

   If the in-scope set is non-empty and every in-scope entry has
   `mergeCompleted: true`, print the completed set and any orphan notice,
   then exit 0 without testing, CI, or mutations.

4. For each unfinished in-scope entry (called `r` in prose), bind these
   shell variables from its context values before using the command
   examples:
   - `repo_name` = `r.name`; `repo_path` = `r.path`.
   - `repo_base` = `r.baseBranch`.
   - `repo_pr_number` = `r.prNumber`.
   - `repo_worktree` = `"${projectDir}/.redqueen/worktrees/${issueId}/${repo_name}"`.

   Rebind these variables for every entry, in `repos` order.

5. Check every unfinished in-scope entry for a non-null `prNumber` and an
   existing `repo_worktree`. An entry with both is usable. A null active PR
   or missing worktree is a failure requiring coding, never a pass: record
   the missing repo and continue to the other unfinished entries.
   - Missing worktree with an active PR — publish that repo's results in
     Step 6 with checks marked `n/a` and the missing-worktree cause.
   - Missing PR — there is no PR destination. Report it in the set summary
     without substituting its historical PR.

## Execution

Run Steps 1–5 for every usable unfinished in-scope entry, in `repos` order.
Before each repo, reset all build/test/CI statuses to `n/a`, and reset the
failure flags, captured output, and targeted/full pre-existing
classifications. A failure may skip later checks for that repo, but must not
exit before processing its siblings. Store results by repo name and active
PR number.

After the loop, run Steps 6–7 once for the set: publish every available
unfinished PR's results, print the set summary, and route once using the
decisions in Step 7.

### Step 1: Choose commands

Choose commands afresh for each `r`:

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

Run the build command inside the repo's worktree:

```
git -C "${repo_worktree}" rev-parse HEAD  # sanity check
cd "${repo_worktree}"
<build command>
```

If build fails:

1. Capture the last ~100 lines of output for your summary.
2. Mark this repo failed with `Build: fail`, and leave its unreached checks
   (targeted / full / CI) `n/a`.
3. Continue with the next repo. Defer publishing and exiting until the set
   has been processed.

### Step 3: Run the targeted tests

```
<targeted test command>
```

If tests fail:

1. Determine whether the failures are related to the PR's changes. Run the
   same command against a fresh worktree from the same repo's base,
   following **Compare against the same repo's base** below.
2. If the failures exist on the repo's base too, they are pre-existing —
   note in summary but do not block. Continue.
3. If the failures are new in this PR, this repo requires coding. Handle it
   like a build failure: capture the output, mark this repo failed, leave
   its unreached checks `n/a`, and continue with the next repo.

#### Compare against the same repo's base

For each failed test category, use a fresh, owned temporary worktree from
the **same repo** as the failing coding worktree. Compare targeted failures
with that repo's exact targeted command; compare full-suite failures with
its exact full command. Reset this category's pre-existing flag before each
comparison; a targeted result must not classify a distinct full command's
failures or another repo. When both categories use the same command, share
that single run and comparison as described in Step 1.

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
so Step 7 routes to coding, or to Blocked for an identified infrastructure
failure.

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

Run the full command selected in Step 1 when it is distinct from the
targeted command, to catch regressions. If it fails, apply the same
pre-existing-vs-new classification as Step 3, using a new same-repo base
comparison with this full command; do not reuse the targeted flag.

### Step 5: Verify CI status

Run this command for each unfinished in-scope PR whose checks are reached:

```sh
redqueen pr checks "${repo_pr_number}" --repo "${repo_name}" --wait 300
```

Read the JSON output. Keep CI results separate by repo.

- All `conclusion` are `"success"` / `"skipped"` / `"neutral"`: CI green.
- Any `"failure"`: determine whether the failures are related to this PR
  (check names, error output). If related, this repo requires coding; a new
  failure in any repo fails the set. If infrastructure-related (DB
  migration, env config), record an identified infrastructure failure for
  the Blocked path.
- Still `"pending"` after 300 seconds: print a warning and record `pending`,
  never `pass`. The set may still advance if it has no other failure — the
  next iteration or human review will catch it.
- The checks command itself fails: CI is unverified, not pending or green,
  and must not produce a successful testing verdict.

### Step 6: Publish results to the PRs

On **every** run — pass, route-to-coding, or Blocked — post a results
comment before you exit. After collecting the set's results, post one to
every unfinished in-scope entry with a non-null active PR, including PRs
whose worktree or commands were missing. It is append-only: never edit or
delete a prior comment, so each PR keeps a per-run history. Fill in only the
rows you reached (a build failure leaves targeted / full / CI as `n/a`):

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

Use a real UTC timestamp, e.g. from `date -u +%Y-%m-%dT%H:%M:%SZ`.

Each comment contains only that repo's detailed rows plus the same one-line
set summary; a missing PR/worktree is `fail`, and pending after the timeout
is explicitly noted alongside any passing verdict. Completed entries are
`merged`, not newly tested. Report orphaned PRs separately in stdout; do
not comment on completed or orphaned PRs. Check every comment command and
attempt the remaining destinations if one fails. A failed publication
must be reported and must not allow a successful exit.

### Step 7: Summary and routing

Print one line per in-scope repo with its PR identity, build/targeted/full/CI
statuses, pre-existing findings, and failure cause. Label completed entries
merged and untested this run. Add any orphan notice, then a final set
verdict and routing decision. This becomes `priorContext`.

After all available results comments have been attempted, check for failed
helper calls or publications first: report them and exit 1 before any
routing path that would exit successfully. Otherwise decide once for the
set:

- Coder-fixable or unknown-cause build/test/CI failures, unavailable
  commands, or unverified checks require coding: exit 1 so the orchestrator
  uses `phase.onFail` (typically `coding`) and its existing iteration limits.
  Record any missing active PR/worktree too. If missing PRs/worktrees are
  the only coding causes, use the checked
  `redqueen issue set-phase "${issueId}" coding` command from Setup step 3
  once, then exit 0 on success or 1 if routing fails. Keep infrastructure
  causes in the summary; these coding causes take precedence while they
  remain.
- If the only failures are identified infrastructure failures, use the
  Blocked path once for the issue. This includes unavailable tools or
  environment-dependent checks whose infrastructure cause was established,
  rather than unknown or coder-fixable failures.
- Otherwise exit 0 only after all unfinished repos have been tested and
  all results published. Verified pre-existing failures and CI still
  pending after the timeout do not block this exit, but remain explicitly
  noted exceptions.

## Blocked path

Step 7 routes here when the only failures in the set are identified
infrastructure failures (missing migration, missing env var, external
service outage). Run it once for the issue, after Step 6 has posted each
repo's results. Check each write succeeds; any failed write or phase change
exits 1 and must not silently advance.

1. Post one tracker comment for the whole set, combining the infrastructure
   causes and the affected repo/PR identities:
   ```
   echo "Blocked — <combined causes, naming each affected repo and PR>. Action: <what the human must do>." | redqueen issue comment <issueId>
   ```
2. Post the same text via a review on every unfinished in-scope entry with
   a non-null active PR, rebinding the repo variables each time:

   ```sh
   echo "<combined blocked causes and required human action>" | redqueen pr review "${repo_pr_number}" --repo "${repo_name}" --verdict request-changes
   ```

   Do not review completed or orphaned PRs, or substitute a historical PR
   for a missing active one.

3. Move the issue into the Blocked human-gate so the orchestrator stops
   advancing the pipeline and assigns the reporter. Perform the phase
   change once for the whole set. Exit non-zero on failure so the
   orchestrator doesn't advance normally:

   ```
   if ! redqueen issue set-phase "${issueId}" blocked; then
     echo "Could not route to blocked — summary: phase-change failed"
     exit 1
   fi
   ```

4. After a successful phase change to `blocked`, print the per-repo and set
   summary, including "Blocked on infrastructure — <cause>.", and exit 0 so
   the orchestrator respects the human gate.

## Important rules

- Never modify code in the tester phase. If something needs fixing, route
  to coding.
- Run each repo's tests from its worktree directory, not its main checkout
  or the workspace root.
- Capture both stdout and stderr for failure diagnosis. Truncate long
  outputs to the last ~100 lines in your summary.
- Distinguish new failures (route to coding) from pre-existing failures
  (note but don't block) from infrastructure failures (set Blocked). The
  pipeline should not ping-pong the same infra issue back to the coder.
- Use standard markdown in PR and tracker output, never Jira wiki syntax.
- Keep the tester read-only with respect to implementation code; temporary
  same-repo base worktrees are only for verification.
