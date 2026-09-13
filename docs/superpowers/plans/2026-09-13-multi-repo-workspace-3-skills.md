# Multi-Repo Workspaces — Plan 3 of 5: Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-09-13-multi-repo-workspace-design.md` §9 (Skills), §4 (worktree layout), §7 (helper flags). **Prerequisites:** plans 1 and 2 are merged — the skill context carries `repos` in workspace mode, `spec meta --repos` exists, `pr`/`pipeline update` take `--repo`, `stack setup` loops repos and its conflict JSON names the repo.

**Goal:** All five built-in skills gain one rule — _if `repos` is absent behave exactly as today; if present, loop over it as described_ — so a workspace ticket produces one branch and one PR per in-scope repo, and the prompt-writer decides scope once and records it with `redqueen spec meta --repos`.

**Architecture:** Skills are markdown prompt templates, not code (CLAUDE.md). Each task edits one `SKILL.md` by inserting a **Workspace mode** subsection at the points where the legacy flow assumes a single repo, always guarded by "when `repos` is present in the context". Legacy text is untouched so single-repo behavior is unchanged. Skills never infer repos from paths or keywords: the coder, reviewer, tester, and comment-handler act only on `repos[]` entries with `inScope: true` (plus the orphan notice); only the prompt-writer decides scope.

**Tech Stack:** Markdown; `prettier --check src/` (part of `npm run check`) formats `src/skills/**/*.md`.

## Global Constraints

- Every skill: if `repos` is absent, behave exactly as today; if present, use it as described here. Never rebase a stacked worktree.
- Worktree paths in workspace mode: `${projectDir}/.redqueen/worktrees/${issueId}/${repo.name}` (coding) and `${projectDir}/.redqueen/worktrees/spec-${issueId}/${repo.name}` (spec). `projectDir` is the workspace root, which is **not** a git repository: raw git runs as `git -C "${repo.path}" …` or inside a worktree.
- Every `redqueen pr …` and `redqueen pipeline update` call in workspace mode passes `--repo <repo.name>`.
- Prompt-writer: read the workspace map; for each candidate repo read `<repo.path>/CLAUDE.md` and `<repo.path>/AGENTS.md` when present (cap ~200 lines each); create a spec worktree for **every** repo; grep only candidates; spec gains a required **Repos in Scope** section (one line of reasoning per repo) and groups **Files to Change** by repo; cross-repo contracts spelled out; `redqueen spec meta <issueId> --open-questions N --repos <names>`; remove all spec worktrees.
- Coder: if no repo is `inScope`, route back to `spec-writing` exactly like a missing spec; loop in-scope repos (worktree, implement, build/test with `repo.module ?? repo`, commit, push, `pr create --repo`); rework modes loop the same rows; stdout summary and PR bodies list every PR in the set and name orphaned PRs (a repo with `inScope: false` and `prNumber` non-null).
- Reviewer: one review per in-scope PR; fail (exit non-zero) if any PR has blockers; a cross-repo contract implemented on one side only is a blocker.
- Tester: build and test per in-scope worktree; pre-existing-failure check uses a base worktree of the same repo; any failure routes to coding.
- Comment-handler: loop every in-scope PR.
- Standard markdown only in tracker output; keep `npm run check` clean.

---

## File Structure

| File                                  | Change                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `src/skills/README.md`                | Stacked-issue and write-surface notes mention the per-repo flags and layout    |
| `src/skills/prompt-writer/SKILL.md`   | Workspace-mode orientation, per-repo spec worktrees, Repos in Scope, `--repos` |
| `src/skills/coder/SKILL.md`           | Empty-scope guard, per-repo loop, `--repo`, PR-set summary and orphan notice   |
| `src/skills/reviewer/SKILL.md`        | One review per in-scope PR, set-wide spec compliance                           |
| `src/skills/tester/SKILL.md`          | Per-repo worktree/build/test, base worktree per repo, `--repo`                 |
| `src/skills/comment-handler/SKILL.md` | Loop in-scope PRs                                                              |

Verification for every task: `npm run check` (prettier formats the markdown) and a `grep` that the new headings landed. There is no automated test of prompt behavior; the smoke test at the end runs a two-repo ticket by hand.

---

### Task 1: Skills README — per-repo helpers and layout

**Files:**

- Modify: `src/skills/README.md` (the "Stacked issues" paragraph after the table, "What skills can read", "What skills can write")

- [ ] **Step 1: Edit the README**

Replace the "**Stacked issues:**" paragraph with:

```markdown
**Stacked issues:** when `stackBlockedBy` is present, worktree setup goes
through `redqueen stack setup <issueId>` (or `--spec` for the prompt-writer's
throwaway exploration worktree) instead of raw git — it branches from base and
merges unmerged ancestor branches in topo order. Never rebase a stacked
worktree. In workspace mode `stack setup` loops the in-scope repos (every repo
with `--spec`), its JSON output lists one entry per repo under `repos`, and a
merge conflict (exit 2) names the conflicting `repo`.

**Worktree layout:** legacy mode uses `${projectDir}/.redqueen/worktrees/<issueId>`
(`spec-<issueId>` for exploration). Workspace mode nests one directory per repo:
`${projectDir}/.redqueen/worktrees/<issueId>/<repo.name>` and
`${projectDir}/.redqueen/worktrees/spec-<issueId>/<repo.name>`. The workspace
root is not a git repository — run raw git as `git -C "<repo.path>" …` or inside
a worktree.
```

In "What skills can read" change the first bullet to:

```markdown
- Files under `projectDir` via Glob / Grep / Read (workspace mode: under each
  `repos[].path`, plus `<repo.path>/CLAUDE.md` and `<repo.path>/AGENTS.md`)
```

In "What skills can write" change the helper bullets to:

```markdown
- `redqueen spec set`, `redqueen spec meta` (`--repos <names>` records which
  repos a ticket touches in workspace mode), `redqueen issue comment`,
  `redqueen pr create`, `redqueen pr review`, `redqueen pr reply` — every
  `pr` subcommand takes `--repo <name>` in workspace mode
- `redqueen pipeline update` (branch / PR / worktree metadata; `--repo <name>`
  in workspace mode)
- `redqueen stack setup` (stacked-issue worktree assembly, per repo)
```

- [ ] **Step 2: Verify + commit**

```bash
npm run check
grep -n "Worktree layout" src/skills/README.md
git add src/skills/README.md
git commit -m "docs(skills): document per-repo helpers and the nested worktree layout"
```

---

### Task 2: prompt-writer

**Files:**

- Modify: `src/skills/prompt-writer/SKILL.md`

The prompt-writer is the only skill with new judgement: it chooses which repos are in scope and records the decision.

- [ ] **Step 1: Input section**

After the `stackBlockedBy` bullet (line ~52) add:

```markdown
- `repos` — **present only in workspace mode**: every configured repo as
  `{name, path, baseBranch, buildCommand, testCommand, inScope, branchName,
prNumber, module}`. `path` is absolute. `inScope` is `false` for every repo
  until you record scope in Step 8 (`redqueen spec meta … --repos`). When
  `repos` is present, `projectDir` is the workspace root and is **not** a git
  repository: `baseBranch`, `buildCommands`, `testCommands`, `repoOwner`, and
  `repoName` describe only `repos[0]` and are deprecated — use each repo's own
  fields. When `repos` is absent, behave exactly as described below.
```

- [ ] **Step 2: Shared setup — orientation per repo**

Replace step 1 of "Shared setup (both flows)" with:

```markdown
1. If `codebaseMapPath` is not null, read it. It is your architecture guide.
   **Workspace mode (`repos` present):** the map has one `## Repo: <name>`
   section per repo. After reading it, decide which repos the ticket could
   plausibly touch (be generous — a wrong exclusion here cannot be recovered
   downstream). For each candidate, read `<repo.path>/CLAUDE.md` and
   `<repo.path>/AGENTS.md` when they exist, at most ~200 lines each. Do this
   explicitly now, before any grep: you need the orientation to know where to
   look, and it must not depend on on-demand loading.
```

- [ ] **Step 3: Fresh Write Flow Step 4 — a spec worktree per repo**

Insert before the "**Non-stacked issue:**" paragraph of Step 4:

```markdown
**Workspace mode (`repos` present), stacked:** `redqueen stack setup "${issueId}" --spec`
builds a detached exploration worktree for **every** repo at
`.redqueen/worktrees/spec-${issueId}/<repo.name>`; the JSON `repos` array lists
each one. Exit 2 names the conflicting `repo` — note it in Risks and explore
what was left behind. Skip the raw git commands below.

**Workspace mode, non-stacked:** create one exploration worktree per repo — all
of them, not only the candidates from setup step 1; worktrees are cheap and the
true candidates are only knowable after reading code. For each entry `r` of
`repos`:
```

bare_base=$(echo "${r.baseBranch}" | sed 's|^origin/||')
git -C "${r.path}" fetch origin "${bare_base}"
git -C "${r.path}" worktree add "${projectDir}/.redqueen/worktrees/spec-${issueId}/${r.name}" "${r.baseBranch}"

```

If a repo's worktree already exists from a prior run, refresh it instead:

```

git -C "${projectDir}/.redqueen/worktrees/spec-${issueId}/${r.name}" fetch origin "${bare_base}"
git -C "${projectDir}/.redqueen/worktrees/spec-${issueId}/${r.name}" reset --hard "${r.baseBranch}"

```

Then skip the legacy commands below and continue to Step 5.
```

- [ ] **Step 4: Step 5 — grep only candidates**

Append to Step 5 ("Explore the codebase"):

```markdown
**Workspace mode:** grep only the candidate repos' worktrees from setup step 1.
Drop a candidate the moment it proves irrelevant; add a repo you had excluded
only if the code you read points at it (an endpoint the backend calls, a
template name a service references). The repos that survive are the ticket's
scope.
```

- [ ] **Step 5: Step 6 — Repos in Scope and per-repo files**

In the "Required sections" list of Step 6, insert after **Root Cause / Context**:

```markdown
- **Repos in Scope** — _required in workspace mode, omit otherwise._ One line
  per in-scope repo with the reason it is touched, and one line per candidate
  you dropped with why. Repos not listed here will never be coded, reviewed,
  or tested for this ticket.
```

and change the **Files to Change** bullet to:

```markdown
- **Files to Change** — exhaustive, concrete, with function / class names.
  Workspace mode: group them under one `### <repo.name>` heading per in-scope
  repo, and spell out every cross-repo contract (endpoint shape, event name,
  template name the backend references, shared config key) so each repo's part
  can be implemented and reviewed on its own.
```

- [ ] **Step 6: Step 8 — record scope**

Replace the `redqueen spec meta` command block in Step 8 with:

```markdown

```

redqueen spec meta <issueId> --open-questions <N>

```

**Workspace mode:** `--repos` is required and must list exactly the repos named
under **Repos in Scope**, comma-separated, using the `name` values from
`repos`:

```

redqueen spec meta <issueId> --open-questions <N> --repos <name>[,<name>…]

```

The helper records the scope the orchestrator and every downstream skill route
on. Names not in the config are rejected — copy them from the context block.
```

- [ ] **Step 7: Step 9 — clean up every spec worktree**

Replace the command block of Step 9 with:

```markdown

```

git worktree remove "${projectDir}/.redqueen/worktrees/spec-${issueId}"

```

**Workspace mode:** remove each repo's worktree from that repo:

```

git -C "${r.path}" worktree remove "${projectDir}/.redqueen/worktrees/spec-${issueId}/${r.name}"

```

for every entry `r` of `repos`, then delete the now-empty
`${projectDir}/.redqueen/worktrees/spec-${issueId}` directory.
```

- [ ] **Step 8: Revision Flow**

Append to "Rev Step 3: Refresh the worktree": `Workspace mode: refresh one worktree per repo as in Fresh Write Flow Step 4.`

Append to "Rev Step 5: Revise the spec":

```markdown
Workspace mode: re-evaluate **Repos in Scope**. Feedback may add a repo (a
template the reviewer wants alongside the backend) or drop one. Keep the section
and the per-repo **Files to Change** groups consistent with the code you
re-verified.
```

Replace the command block of "Rev Step 7" with the same two-variant block as Step 6 above (legacy without `--repos`, workspace with `--repos`). A repo dropped by a revision keeps any branch or PR it already has; `redqueen status` shows it as orphaned for a human to close — do not try to clean it up yourself.

- [ ] **Step 9: Verify + commit**

```bash
npm run check
grep -n "Repos in Scope\|--repos\|spec-\${issueId}/\${r.name}" src/skills/prompt-writer/SKILL.md
git add src/skills/prompt-writer/SKILL.md
git commit -m "feat(prompt-writer): decide repo scope once and record it with spec meta --repos"
```

---

### Task 3: coder

**Files:**

- Modify: `src/skills/coder/SKILL.md`

- [ ] **Step 1: Input section**

After the `stackPrBase` bullet add:

```markdown
- `repos` — **present only in workspace mode**: every configured repo as
  `{name, path, baseBranch, buildCommand, testCommand, inScope, branchName,
prNumber, module, stackPrBase?}`. Work only on entries with `inScope: true`.
  Each entry's `module` is that repo's resolved module (or null) and its
  `stackPrBase` (stacked issues only) is the branch that repo's PR must target.
  When `repos` is present, `projectDir` is the workspace root (not a git
  repository) and the top-level `baseBranch`, `buildCommands`, `testCommands`,
  `module`, `branchName`, `prNumber`, and `stackPrBase` describe only the first
  in-scope repo — do not use them; use each entry's own fields. When `repos` is
  absent, behave exactly as described below.
```

- [ ] **Step 2: Step 1 — empty-scope guard**

Append to Step 1 ("Verify the spec exists"):

```markdown
**Workspace mode:** also route back to `spec-writing` (same command, same
audit-only rule) when no entry of `repos` has `inScope: true`, or when the spec
has no **Repos in Scope** section. Never guess which repos a ticket touches —
scope is the prompt-writer's decision, recorded with `redqueen spec meta --repos`.
```

- [ ] **Step 3: Step 2 — names per repo**

Append to Step 2:

```markdown
**Workspace mode:** `branch_name` is the same in every repo. Compute the rest
per in-scope repo `r`:

- `bare_base(r)` = `r.baseBranch` with the `origin/` prefix removed.
- `worktree_path(r)` = `"${projectDir}/.redqueen/worktrees/${issueId}/${r.name}"`.
```

- [ ] **Step 4: Step 3 — one worktree per repo**

Insert at the start of Step 3 (before the stacked paragraph):

```markdown
**Workspace mode:** repeat this step for every in-scope repo `r`. Stacked
issues run `redqueen stack setup "${issueId}"` **once** — it loops the in-scope
repos and lists them under `repos` in its JSON; on exit 2 the JSON names the
conflicting `repo`: resolve inside `worktree_path(r)` for that repo, then re-run
until exit 0. Non-stacked issues use the raw git commands below with
`git -C "${r.path}"` in place of bare `git`, `r.baseBranch` in place of
`baseBranch`, `bare_base(r)` and `worktree_path(r)`, then record each worktree:
```

redqueen pipeline update "${issueId}" --repo "${r.name}" --worktree "${worktree_path(r)}"

```

```

- [ ] **Step 5: Steps 4–5 — implement and verify per repo**

Append to Step 4:

```markdown
**Workspace mode:** implement each repo's part from its `### <repo.name>` group
under **Files to Change**, inside that repo's worktree. Honour the cross-repo
contracts the spec spells out — the same endpoint shape, event name, or template
name on both sides.
```

Append to Step 5:

```markdown
**Workspace mode:** run the build and targeted tests in every in-scope repo's
worktree, choosing commands from that entry: `r.module.buildCommand` if
`r.module` is non-null else `r.buildCommand`, and `r.module.testCommandTargeted
?? r.testCommand`.
```

- [ ] **Step 6: Steps 6–8 — commit, push, one PR per repo**

Append to Step 7 ("Push"): `Workspace mode: push from each in-scope worktree (`git -C "${worktree_path(r)}" push -u origin "${branch_name}"`).`

Replace Step 8's introduction ("Compute `pr_base` first: …") and command with:

```markdown
Compute `pr_base` first: the context's `stackPrBase` when present (stacked
issue), otherwise `bare_base`.

**Workspace mode:** open one PR per in-scope repo, in `repos` order.
`pr_base(r)` is `r.stackPrBase` when present, otherwise `bare_base(r)`. Pass
`--repo "${r.name}"`, and add a **Change-set** section so the human gate sees
the whole set from any one PR:
```

cat <<'EOF' | redqueen pr create \
 --repo "${r.name}" \
  --issue "${issueId}" \
 --head "${branch_name}" \
  --base "${pr_base(r)}" \
 --title "<type>(<issueId>): <summary> [<r.name>]"

## Summary

<from spec — this repo's part>

## Change-set

Part of a cross-repo change for ${issueId}. Sibling PRs (same branch `${branch_name}`):

- <other in-scope repo name>: opens after this one — see the change-set comment below
  <if any repo has inScope: false and a non-null prNumber:>
- ORPHANED: <repo name> PR #<prNumber> — this repo was dropped from scope by a later spec revision; a human should close or merge it.

## Changes

- <bullet list of what changed in this repo>

## Test Plan

<from spec — this repo's part>

## Refs

${issueId}
EOF

```

After the last PR is created, post one comment on **every** PR in the set that
lists all of them by number and URL (the `pr create` JSON has `number` and
`url`), so a reviewer landing on any PR can reach the others:

```

cat <<'EOF' | redqueen pr comment "${prNumber(r)}" --repo "${r.name}"

## Change-set for ${issueId}

- api: #12 <url>
- email-templates: #7 <url>
  EOF

```

Legacy mode (no `repos`) opens the single PR exactly as before:
```

(keep the existing single-PR `cat <<'EOF' | redqueen pr create …` block after this paragraph, unchanged).

- [ ] **Step 7: Step 9 — summary of the set**

Append to Step 9: `Workspace mode: list every PR in the set (`<repo>: #<n>`), the build + test status per repo, and any ORPHANED PR by repo and number.`

- [ ] **Step 8: Rework modes**

After the "Rework modes" introduction paragraph add:

```markdown
**Workspace mode:** every rework round loops the in-scope repos: refresh each
worktree (stacked: one `redqueen stack setup` run covers all of them;
non-stacked: `git -C "${worktree_path(r)}" fetch origin "${bare_base(r)}"` then
`rebase "${r.baseBranch}"`), read that repo's review with
`redqueen pr reviews "${r.prNumber}" --repo "${r.name}" --latest`, fix, build
and test with that repo's commands, commit and push from that worktree. Post
the rework-response comment on the PR whose blockers you pushed back on, with
`--repo`. Never open a new PR; a repo whose `prNumber` is null on a rework
round means the first round failed there — open its PR now as in Step 8.
```

- [ ] **Step 9: Blocked path**

Change item 2 of the Blocked path to: `2. If a PR exists, also `redqueen pr review <prNumber> --verdict request-changes`with the same text so the human sees it from either place. Workspace mode: do this for every in-scope PR, each with`--repo`.`

- [ ] **Step 10: Verify + commit**

```bash
npm run check
grep -n "Change-set\|--repo \"\${r.name}\"\|inScope: true" src/skills/coder/SKILL.md
git add src/skills/coder/SKILL.md
git commit -m "feat(coder): one worktree, branch and PR per in-scope repo"
```

---

### Task 4: reviewer

**Files:**

- Modify: `src/skills/reviewer/SKILL.md`

- [ ] **Step 1: Input section**

After the `codebaseMapPath` bullet add:

```markdown
- `repos` — **present only in workspace mode**: review every entry with
  `inScope: true` and a non-null `prNumber`; pass `--repo <name>` on every
  `redqueen pr` call. The top-level `prNumber` describes only the first in-scope
  repo — do not rely on it. If `repos` is present but no in-scope entry has a
  PR, exit non-zero with "no PR in scope" exactly like a null `prNumber`. When
  `repos` is absent, behave exactly as described below.
```

- [ ] **Step 2: Steps 2–4 — per PR**

Append to Step 2 ("Fetch the diff"):

```markdown
**Workspace mode:** fetch every in-scope PR's diff
(`redqueen pr diff "${r.prNumber}" --repo "${r.name}"`) before reviewing any
of them — cross-repo contracts can only be checked with both sides in view.
```

Append to the **Spec compliance** category:

```markdown
- Workspace mode: every cross-repo contract the spec spells out (endpoint
  shape, event name, template name, config key) must be implemented on **every**
  side. A contract implemented in one repo only is a blocker on the PR that is
  missing its side.
```

Append to Step 4 ("Check CI status"): `Workspace mode: check each in-scope PR (`redqueen pr checks "${r.prNumber}" --repo "${r.name}"`).`

- [ ] **Step 3: Steps 5–6 — one report per PR, one verdict for the set**

Append to Step 5:

```markdown
**Workspace mode:** write one report per PR, scoped to that repo's changes,
plus a short **Change-set** line at the top of each naming the sibling PRs.
```

Insert after the first paragraph of Step 6 ("Combine code quality and CI status…"):

```markdown
**Workspace mode:** post each PR's report with
`redqueen pr review "${r.prNumber}" --repo "${r.name}" --verdict <approve|request-changes>`
— `request-changes` on the PRs that have blockers, `approve` on the clean ones.
The **exit code is for the set**: exit non-zero if **any** PR has blockers
(the coder reworks every repo), exit zero only when every PR is approved and
CI-green. The Blocked path applies to the set the same way.
```

- [ ] **Step 4: Verify + commit**

```bash
npm run check
grep -n "exit code is for the set\|--repo \"\${r.name}\"" src/skills/reviewer/SKILL.md
git add src/skills/reviewer/SKILL.md
git commit -m "feat(reviewer): review every in-scope PR and fail the set on any blocker"
```

---

### Task 5: tester

**Files:**

- Modify: `src/skills/tester/SKILL.md`

- [ ] **Step 1: Input section**

After the `baseBranch` bullet add:

```markdown
- `repos` — **present only in workspace mode**: test every entry with
  `inScope: true`. Each carries its own `path`, `baseBranch`, `buildCommand`,
  `testCommand`, `module`, and `prNumber`; the top-level fields describe only
  the first in-scope repo — do not use them. When `repos` is absent, behave
  exactly as described below.
```

Replace the paragraph "The worktree path is read from pipeline state…" with:

```markdown
The worktree path is read from pipeline state. It is the directory the coder
created at `.redqueen/worktrees/<issueId>` inside `projectDir` — in workspace
mode `.redqueen/worktrees/<issueId>/<repo.name>`, one per in-scope repo.
```

- [ ] **Step 2: Setup and commands**

Replace Setup step 2 with:

```markdown
2. Determine the worktree path: `${projectDir}/.redqueen/worktrees/${issueId}`.
   **Workspace mode:** `${projectDir}/.redqueen/worktrees/${issueId}/${r.name}`
   for each in-scope repo `r`; run Steps 1–4 once per repo, in `repos` order.
```

Append to Step 1 ("Choose commands"): `Workspace mode: per repo — build `r.module.buildCommand`if`r.module`is non-null else`r.buildCommand`; targeted `r.module.testCommandTargeted ?? r.testCommand`; full `r.module.testCommandFull ?? r.testCommand`.`

- [ ] **Step 3: Step 3 — base worktree per repo**

Replace the pre-existing-failure command block in Step 3 with:

```markdown

```

test_base="/tmp/redqueen-test-base-${issueId}"
bare_base=$(echo "${baseBranch}" | sed 's|^origin/||')
git worktree add --detach "${test_base}" "${baseBranch}"
(cd "${test_base}" && <targeted test command>) || pre_existing=true
git worktree remove "${test_base}"

```

**Workspace mode:** the base worktree must come from the **same repo** as the
failing worktree:

```

test_base="/tmp/redqueen-test-base-${issueId}-${r.name}"
git -C "${r.path}" fetch origin "$(echo "${r.baseBranch}" | sed 's|^origin/||')"
git -C "${r.path}" worktree add --detach "${test_base}" "${r.baseBranch}"
(cd "${test_base}" && <targeted test command for r>) || pre_existing=true
git -C "${r.path}" worktree remove "${test_base}"

```

```

- [ ] **Step 4: Steps 5–7 — CI, results, summary**

Append to Step 5: `Workspace mode: `redqueen pr checks "${r.prNumber}" --repo "${r.name}" --wait 300` for each in-scope repo. A new failure in **any** repo routes the whole ticket to coding; an infra failure in any repo sets Blocked.`

Append to Step 6 ("Publish results to the PR"): `Workspace mode: post the results comment on each in-scope PR with `--repo "${r.name}"`, containing only that repo's rows plus a one-line "Set: <repo>: pass|fail, …" summary.`

Append to Step 7: `Workspace mode: one line per repo, then the set verdict.`

In the Blocked path items 2 and the `pr review` command: add `--repo "${r.name}"` and note "on every in-scope PR".

- [ ] **Step 5: Verify + commit**

```bash
npm run check
grep -n "same repo\|--repo \"\${r.name}\"" src/skills/tester/SKILL.md
git add src/skills/tester/SKILL.md
git commit -m "feat(tester): verify every in-scope repo against its own base"
```

---

### Task 6: comment-handler

**Files:**

- Modify: `src/skills/comment-handler/SKILL.md`

- [ ] **Step 1: Input section**

After the `module` bullet add:

```markdown
- `repos` — **present only in workspace mode**: handle feedback on every entry
  with `inScope: true` and a non-null `prNumber`, passing `--repo <name>` on
  every `redqueen pr` call and using that entry's `buildCommand`, `testCommand`,
  and `module`. When `repos` is absent, behave exactly as described below.
```

Replace "The worktree path is the one the coder created: …" with:

```markdown
The worktree path is the one the coder created:
`${projectDir}/.redqueen/worktrees/${issueId}` — in workspace mode
`${projectDir}/.redqueen/worktrees/${issueId}/${r.name}` per in-scope repo.
```

- [ ] **Step 2: Execution loop**

Insert after the "## Execution" heading:

```markdown
**Workspace mode:** run Steps 1–9 once per in-scope PR, in `repos` order, with
`--repo "${r.name}"` on `pr comments`, `pr reply`, and `pr review`, and that
repo's worktree, build, and test commands. Step 2's iteration limit is checked
once for the ticket, not per repo. Step 10 summarizes every repo.
```

- [ ] **Step 3: Verify + commit**

```bash
npm run check
grep -n "once per in-scope PR" src/skills/comment-handler/SKILL.md
git add src/skills/comment-handler/SKILL.md
git commit -m "feat(comment-handler): address feedback on every in-scope PR"
git push
```

---

## Plan-level verification (manual smoke)

- [ ] `npm run check` clean.
- [ ] Legacy prompt bytes: render any skill for a legacy config and confirm the context block has no `repos:` key (`npx vitest run src/core/__tests__/skill-context.test.ts` covers this); the SKILL.md text itself changes, which is expected — the spec's byte-identical guarantee is about the context block.
- [ ] Workspace dry run: on a scratch two-repo workspace with the mock tracker, dispatch a ticket and read the rendered prompt in `.redqueen/tmp/<task>.md` — `repos:` lists both repos with `inScope: false` before spec-writing; after `redqueen spec meta X --open-questions 0 --repos a`, the coder prompt shows `a` with `inScope: true`.

## Self-review notes

- §9 prompt-writer items 1–6 map to Task 2 Steps 2–7; coder rules (empty scope, loop, rework, PR set + orphan) to Task 3; reviewer to Task 4; tester to Task 5; comment-handler to Task 6; README to Task 1. The "PR bodies list every PR" requirement is met with a body section naming the siblings plus a per-PR change-set comment carrying numbers (numbers are unknown until each PR exists).
