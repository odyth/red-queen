# Multi-Repo Workspaces

**Date:** 2026-09-13
**Status:** Approved design, pending implementation
**Scope:** `src/core/config.ts`, `src/core/database.ts`, `src/core/pipeline-state.ts`, `src/core/skill-context.ts`, `src/core/module-resolver.ts`, `src/core/orchestrator.ts`, `src/core/reconciler.ts`, `src/core/rework-transition.ts`, `src/core/stack.ts`, `src/webhook/server.ts`, `src/integrations/github/webhook.ts`, `src/cli/{adapters,init,migrate,pr,pipeline,stack,spec,status,codebase-map,detect}.ts`, all five `src/skills/*/SKILL.md`, dashboard config/status partials, docs.

## Problem

Red Queen binds to exactly one git repository. Four things enforce it:

- `project.directory` is the worker cwd and the skills' `projectDir`.
- `sourceControl.config.owner/repo` binds the GitHub adapter to one repo.
- `pipeline_state` holds one `branch_name`, `pr_number`, `pr_base_branch`,
  `terminal_pr_number`, `worktree_path` per issue.
- Every `redqueen pr` / `redqueen pipeline` helper takes a bare PR number.

Teams with several repos per product (AlignSmart: `AlignSmart`, `App`,
`Infrastructure`, `EmailTemplates`, `ImageResizer`) run one instance per repo
and hand-split cross-repo tickets. A ticket like "add a new email type" needs
the backend wired _and_ the template authored; today a human builds the
template and the ticket only covers the backend.

Side finding fixed by this design: `codebaseMapPath` is never passed to
`buildSkillContext` by the orchestrator, so the map `init` generates is never
read by any skill.

## Goals

1. One instance, many repos. A ticket may touch any subset of them.
2. Existing single-repo installs keep working with no config change and
   byte-identical skill prompts.
3. No new tracker fields. Routing comes from the spec, not from a "product"
   field on the ticket.
4. No AI in the orchestrator. Repo selection is an AI decision made once, in
   the prompt-writer, and recorded as structured metadata the orchestrator
   routes on deterministically.
5. Bounded context cost. Workers read a short workspace map plus each
   candidate repo's own `CLAUDE.md` / `AGENTS.md`, then grep only the repos
   the ticket plausibly touches.

## Decisions (made during design review)

1. **Layout:** the install lives at a _workspace root_ that holds
   `redqueen.yaml`, `.env`, and `.redqueen/`. Repos are directories under it
   (or absolute paths). This subsumes "install in a parent folder".
2. **Config:** `project.repos[]`. A repo entry carries its own git identity,
   base branch, and commands. **Modules nest under a repo** (`repos[].modules`)
   because a module is a path subset of one repo and its globs stay
   repo-relative; the module resolver is unchanged and runs per repo worktree.
3. **Mode switch:** the `project.repos` key being present is _workspace
   mode_. Absent is _legacy mode_: the orchestrator synthesizes one repo from
   today's fields and skill prompts stay byte-identical. New single-repo
   `init` keeps writing the legacy shape in this iteration.
4. **N PRs per ticket from day one.** A cross-repo ticket produces one branch
   and one PR per in-scope repo. The per-repo state lives in a new SQLite
   table; the existing scalar columns become a compatibility mirror.
5. **Routing is spec-declared.** The prompt-writer decides which repos are in
   scope and records it with `redqueen spec meta --repos`. Downstream skills
   loop over in-scope repos. Nothing infers repos from paths or keywords.
6. **Done = all in-scope PRs merged.** A partial merge leaves the ticket at
   the human gate. Merge order across repos is the human's call.
7. **Context = existing per-repo docs, not an engine.** The workspace map is
   one short section per repo. Fine-grained knowledge is re-derived per ticket
   from the worktree. No vector index, no cache of file-level facts.
8. **Migration is `redqueen migrate`, up one directory, no path argument.**
   Run inside the current install; it moves the install to the parent and
   lifts config into `repos[0]`. Sibling repos are added afterwards with
   `redqueen init --add-repo <path>`. Move, never copy: two databases polling
   one tracker double-claim tickets.
9. **Issue-tracker binding is independent of `repos[]`.** `github-issues`
   keeps its own `owner/repo` under `issueTracker.config`; that repo need not
   appear in `repos[]`. The github/github pairing rule becomes "same auth" and
   one GitHub client is shared by the tracker and every repo adapter.
10. **Descoping never touches a PR.** A repo row descoped by a later spec
    revision keeps its branch, PR, and worktree with `in_scope = 0`. Done,
    the reconciler skip, and dispatch consider in-scope rows only; `status`
    and the coder's PR bodies flag the row as _orphaned_ for a human to close.
11. **Mirror readers are an allowlist.** Only cost markers, sub-iteration,
    failure notices, and `redqueen status` read the `pipeline_state` scalar
    mirror. Every control decision reads `pipeline_repos` rows.

## Design

### 1. Configuration (`src/core/config.ts`)

```yaml
project:
  directory: . # workspace root; unchanged semantics
  repos:
    - name: alignsmart # ^[a-z0-9][a-z0-9-]*$ — dir segment and CLI arg; see deriveRepoName
      path: ./AlignSmart # relative to project.directory, or absolute
      owner: alignsmart
      repo: AlignSmart
      baseBranch: origin/master # optional; default pipeline.baseBranch
      buildCommand: dotnet build
      testCommand: dotnet test
      modules: # optional; same shape as today's project.modules
        - name: portal
          paths: ["src/Portal/**"]
          buildCommand: dotnet build src/Portal
          testCommandTargeted: dotnet test src/Portal.Tests
    - name: app
      path: ./App
      owner: alignsmart
      repo: App
      buildCommand: npm run build
      testCommand: npm test
```

Rules:

- `repos` requires at least one entry; names unique; `path` must exist and be
  a git work tree root at load time (validated in `loadConfig`, not the zod
  schema, so `parseConfig` stays pure for tests).
- `deriveRepoName(repo)` is the one rule for every derived name (legacy
  synthesis, `migrate`, `--add-repo`): lowercase, collapse each run of
  characters outside `[a-z0-9]` to `-`, strip leading and trailing `-`. The
  result always satisfies the regex; an empty result is a `ConfigError` naming
  the source repo. Hand-written names in `repos[]` must already match the
  regex — they are never transformed.
- When `sourceControl.config.auth` is GitHub App mode, every `repos[].owner`
  must be the same: an installation token is scoped to one owner. A second
  distinct owner is a `ConfigError`. Token auth allows any mix of owners.
- `issueTracker.config.owner/repo` (github-issues) is untouched by workspace
  mode and binds the tracker to its issue repo, which need not be in
  `repos[]`. `buildAdapterPair` drops the github/github owner-repo equality
  check in workspace mode and keeps the shared-auth, shared-client path.
- In workspace mode `project.buildCommand`, `project.testCommand`,
  `project.modules`, and `sourceControl.config.owner/repo` are rejected with a
  message pointing at `repos[]`. No silent precedence rules.
- In legacy mode `loadConfig` synthesizes `repos = [{ name:
deriveRepoName(<sourceControl repo name>), or "default" for mock, path:
project.directory, owner, repo, baseBranch: pipeline.baseBranch, buildCommand,
testCommand, modules }]` and sets an internal `workspaceMode: false`. Every consumer downstream reads
  `config.project.repos`; only skill-context rendering, worktree layout, the
  adapter pairing check, and the dashboard header label branch on
  `workspaceMode`.
- Auth (`token`, `appId`, `installationId`, `privateKey`, `webhookSecret`)
  stays under `sourceControl.config`. A GitHub App installation token is
  installation-wide, so one strategy serves every repo.

`RedQueenConfig` exports `RepoConfig`; `ProjectModule` is unchanged.

### 2. Source-control registry

`createSourceControl` builds one adapter per repo entry sharing one auth
strategy and returns a `SourceControlRegistry`:

```ts
interface SourceControlRegistry {
  get(repoName: string): SourceControl; // throws on unknown name
  byFullName(fullName: string): SourceControl | null; // "owner/repo" → adapter, webhook routing
  names(): string[];
  any(): SourceControl; // webhook signature validation (shared secret)
}
```

`deps.sourceControl` becomes `deps.sourceControls`. The `SourceControl`
interface is untouched: adapters stay single-repo objects. Call sites that
must choose a repo (`pr.ts`, `pipeline.ts`, reconciler, webhook server, merge
cleanup in the orchestrator) take the repo name from the pipeline repo row
they are acting on.

### 3. Pipeline state (`src/core/database.ts`, `src/core/pipeline-state.ts`)

New table:

```sql
CREATE TABLE IF NOT EXISTS pipeline_repos (
  issue_id           TEXT NOT NULL,
  repo               TEXT NOT NULL,
  in_scope           INTEGER NOT NULL DEFAULT 1,
  branch_name        TEXT,
  pr_number          INTEGER,
  pr_base_branch     TEXT,
  terminal_pr_number INTEGER,
  worktree_path      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (issue_id, repo)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_repos_pr ON pipeline_repos(repo, pr_number);
```

`pipeline_state` keeps phase, iterations, spec, prior context, delegator,
open-question count. Its scalar PR columns stay for one release as a
**read-only mirror** of the first in-scope repo row: every write goes through
per-repo methods, and the mirror is refreshed in the same transaction. The
mirror's readers are a closed allowlist — cost markers (`cost-markdown`),
sub-iteration, failure notices, and `redqueen status` — all display-only.
Every control decision moves to per-row reads in this iteration:

- `rework-transition`: `hasPr` is true when any in-scope row has a PR.
- The stack blocker gate (`src/core/stack.ts`) reads per-row branch and PR
  (rules in §7).
- `dismissStaleReviews` after a `requiresPr` phase runs for every in-scope
  row with a PR, via `sourceControls.get(row.repo)`.

A follow-up removes the columns.

`PipelineRecord` gains `repos: PipelineRepoRecord[]` (ordered as in config,
`inScope` flag per row). The scalar fields are derived from the first
in-scope row, or `null` when none.

Store API (new or changed):

- `setScope(issueId, repoNames[])` — upserts rows for the named repos with
  `in_scope = 1`, marks others `in_scope = 0`. Called by `spec meta --repos`.
  Rows with a live PR are never dropped, only descoped: the row keeps its
  branch, PR, and worktree. Done, the reconciler skip, dispatch, and the
  coder's loops consider in-scope rows only. A merge event for a descoped row
  still runs `markPrMerged` on that row (terminal transition plus local
  cleanup) but never advances the issue. `status` labels such rows
  `orphaned`; closing or merging the PR is a human's call.
- `updateBranch(issueId, repo, branch)`, `updatePrNumber(issueId, repo, n,
base)`, `updateWorktreePath(issueId, repo, path | null)`.
- `markPrMerged(issueId, repo, mergedPrNumber)` — per-row terminal transition
  (`terminal_pr_number = pr_number, pr_number = NULL, pr_base_branch = NULL`).
  Returns `"processed" | "already-processed" | "stale" | "missing" |
"pending-others"`; the issue moves to `done` only inside the transaction
  that merges the **last** in-scope row. `classifyMergeTransition` works
  per row, unchanged in spirit.
- `findByPr(repo, prNumber)` — webhook and comment routing.

**Legacy-row adoption.** Schema migration creates the table only. On every
start, before polling, the orchestrator adopts legacy rows deterministically:
for each `pipeline_state` row with a non-null `branch_name`, `pr_number`,
`worktree_path`, or `spec_content` and no `pipeline_repos` rows, insert one
row with `repo = repos[0].name`, `in_scope = 1`. `spec_content` is included
because in legacy mode a written spec implicitly targets the only repo;
without it, a ticket awaiting approval at migration time would be routed
back to spec-writing by the coder's empty-scope rule. Idempotent and
config-aware. `migrate` runs the same adoption in its step 6, so helpers
invoked before the first `start` see the rows too. A hand-edited in-place
conversion is covered by the start-time pass.

### 4. Worktree layout

Workspace mode: `<root>/.redqueen/worktrees/<issueId>/<repoName>` for coding,
`<root>/.redqueen/worktrees/spec-<issueId>/<repoName>` for the prompt-writer's
throwaway exploration. One directory per ticket holds the whole change-set.
Git ops run as `git -C <repo.path> worktree add <that path> …`.

The pr-merged stack refresh's temporary worktree follows the same shape:
`<root>/.redqueen/worktrees/refresh-<issueId>/<repoName>`.

**Every git invocation** — in the orchestrator, webhook server, and CLI
helpers — takes its cwd from the acting row's `repo.path`. Nothing runs git
at the workspace root, which is not a repository. This covers `worktree
add/remove`, `branch -D`, `fetch`, `ls-remote`, `push`, and the module
resolver's `diff`.

Legacy mode keeps `<projectDir>/.redqueen/worktrees/<issueId>` so existing
in-flight worktrees and the byte-identical prompts hold.

### 5. Skill context (`src/core/skill-context.ts`, `src/skills/README.md`)

Workspace mode adds one key, omitted entirely in legacy mode (the same
conditional-spread trick as `stackBlockedBy`):

```yaml
repos:
  - name: alignsmart
    path: /srv/alignsmart/AlignSmart # absolute
    baseBranch: origin/master
    buildCommand: dotnet build
    testCommand: dotnet test
    inScope: true # false for every repo before spec meta --repos
    branchName: feature/PROJ-123 # null before coding
    prNumber: 42 # null before a PR exists
    module: null # per-repo module resolution (see §6)
    stackPrBase: feature/PROJ-100 # stacked issues only; omitted otherwise
```

`stackBlockedBy` stays top-level (it is ticket-level). `stackPrBase` moves
into each repo entry using the same conditional spread, because a dependent's
PR base differs per repo: it is the blocker's branch in repos the blocker
touched and the repo's `baseBranch` elsewhere.

Legacy scalar fields (`buildCommands`, `testCommands`, `baseBranch`,
`repoOwner`, `repoName`, `module`, `branchName`, `prNumber`, `stackPrBase`)
remain present and typed as today. In workspace mode they are populated from the first
in-scope repo (or `repos[0]` before scope is set) so custom single-repo skills
degrade sensibly; the README marks them deprecated in workspace mode.

`projectDir` is the workspace root. `codebaseMapPath` is finally wired: the
orchestrator passes `<projectDir>/.redqueen/codebase-map.md` when the file
exists, in both modes.

### 6. Module resolution (`src/core/module-resolver.ts`)

Unchanged algorithm, run once per repo that has a worktree: `git diff
--name-only <repo.baseBranch>...HEAD` in that worktree, match against that
repo's `modules[].paths`, first match wins. Result lands on
`repos[i].module`. The existing quirk carries over: on a fresh coding pass
there is no diff yet, so `module` is `null` and skills fall back to the
repo-level commands.

### 7. CLI helpers

- `redqueen spec meta <issueId> --open-questions N --repos a,b` — `--repos`
  is required in workspace mode, names must exist in config, at least one.
  Calls `setScope`. Legacy mode ignores `--repos`.
- `redqueen pr create|diff|checks|review|reviews|comments|comment|reply` and
  `redqueen pipeline update` (every flag: `--branch`, `--pr`, `--worktree`,
  `--clear-pr`, `--clear-worktree`) gain `--repo <name>`. Required in
  workspace mode (PR numbers collide across repos), defaulted to the sole
  repo in legacy mode. `pr create` writes the repo row and recomputes the
  stacked base per repo.
- `redqueen stack setup <issueId> [--spec]` loops the in-scope repos (all
  repos with `--spec`). For each repo it merges only the ancestor branches
  that exist in **that** repo's remote; ancestors that never touched the repo
  are skipped, not errors. Exit codes unchanged; the JSON output lists
  per-repo results and the conflicting repo on exit 2.
- **Blocker gate, per repo.** `resolveStack` evaluates each blocker per repo:
  for repo R a blocker is _satisfied_ when its R row has a branch and the
  blocker's tracker phase is a terminal gate; _not applicable_ (skipped) when
  the blocker has no R row; _unsatisfied_ otherwise. The ticket-level gate
  the orchestrator checks before dispatch is unsatisfied while any in-scope
  row of any blocker lacks a PR. Merge branches and `stackPrBase` are
  therefore per repo.
- `redqueen status` and the dashboard status/workflow views list every repo
  row (branch, PR, in-scope flag) per issue. A descoped row that still has a
  PR is labelled `orphaned`.

Config discovery already walks upward from cwd, so helpers invoked from
inside a repo directory find the workspace `redqueen.yaml`.

### 8. Webhooks, reconciler, merge cleanup

- Each repo needs its own GitHub webhook (or one org-level webhook) pointing
  at the same URL with the shared secret. `src/webhook/README.md` and the
  migrate next-steps output say so.
- `src/integrations/github/webhook.ts` adds `repo: payload.repository.full_name`
  to `pr-merged` and `pr-feedback` payloads. The webhook server validates the
  signature with `sourceControls.any()` (shared secret), resolves the adapter
  and repo name with `byFullName`, and calls `markPrMerged(issueId, repo, n)`.
  An event for an unknown full name is audited and dropped.
- Stacked-dependent retargeting on merge runs per repo: dependents whose row
  in the same repo targets the merged branch are retargeted to its base.
- Startup merged-PR reconciliation checks every open repo row with
  `sourceControls.get(row.repo).getPullRequest(row.prNumber)`.
- Merge cleanup (worktree removal, branch deletion) acts on the merged row
  only, with git rooted at that row's `repo.path` (§4). The ticket-level "PR
  merge already processed" skip in the reconciler keys on every **in-scope**
  row having `prNumber === null`; descoped rows are ignored.
- The stack refresh (`refreshDependentBranch`) runs per dependent repo row
  whose base is the merged branch, using the `refresh-<issueId>/<repoName>`
  worktree from §4.
- Post-phase `dismissStaleReviews` (orchestrator, `requiresPr` phases) loops
  every in-scope row with a PR.

### 9. Skills

All five skills gain one rule: _if `repos` is absent, behave exactly as
today; if present, use it as described here._ Worktree paths follow §4.

**prompt-writer** (the only skill with new judgement):

1. Read the workspace map. For each repo the ticket could plausibly touch,
   read `<repo.path>/CLAUDE.md` and `<repo.path>/AGENTS.md` if present (cap
   ~200 lines each). Explicit reads, not on-demand loading, because the
   orientation is needed _before_ choosing where to grep, and Codex needs it
   explicit anyway.
2. Create a spec worktree for **every** repo using that repo's `baseBranch`
   (`redqueen stack setup --spec` when stacked, else `git -C <repo.path>
worktree add` per repo). Candidates are not knowable before reading code
   and worktree creation is cheap; §7's `--spec` behaviour matches.
3. Grep only candidate repos; drop any that turn out irrelevant.
4. Spec gains a required **Repos in Scope** section (one line of reasoning
   per repo) and groups **Files to Change** by repo. Cross-repo contracts
   (endpoint shape, template name the backend references) are spelled out.
5. `redqueen spec meta <issueId> --open-questions N --repos <names>`.
6. Remove all spec worktrees.

**coder:** if no repo is `inScope`, route back to `spec-writing` exactly like
a missing spec. Otherwise loop in-scope repos: worktree, implement that repo's
part of the spec, build/test with `repo.module ?? repo` commands, commit,
push, `pr create --repo`. Rework modes loop the same rows. The stdout summary
and each PR body list every PR in the set so the human gate sees them
together, and name any orphaned PR (a descoped row that still has one) so a
human closes it.

**reviewer:** one review per in-scope PR (`pr diff/checks/review --repo`). The
phase fails (exit non-zero) if any PR has blockers. Spec compliance is judged
across the set: a cross-repo contract implemented on one side only is a
blocker.

**tester:** build and test per in-scope worktree; pre-existing-failure check
uses a base worktree of the same repo. Any failure routes to coding.

**comment-handler:** loops every in-scope PR and addresses unresolved comments
on each. No new context field needed.

### 10. Workspace map (`src/cli/codebase-map.ts`)

`<root>/.redqueen/codebase-map.md`, one `## Repo: <name>` section per repo:

- `### What this repo is (edit me)` — seeded from the first paragraph of the
  repo's `README.md` when present, else a placeholder.
- Generated: Languages, Commands, Top-Level Layout, Entry Points (today's
  generator, per repo).
- `### Key Notes (edit me)` per repo.

`init --map-only` regenerates the generated parts per section and preserves
both edit-me blocks; `mergeRegeneratedMap` becomes section-aware. Legacy
single-repo maps keep today's flat shape.

### 11. `redqueen init` (fresh workspace)

Run in a directory that is **not** a git repo but contains git-repo children →
workspace mode: discover children, print them, prompt which to include (all
with `--yes`), then per repo derive language, suggested commands, `owner/repo`
from `origin` (`parseGitRemote`), and base branch from
`origin/HEAD`. Tracker and source-control auth prompts run once. Writes
`project.repos[]`, `.redqueen/` and the map at the root. Preflight: each
chosen path must be a git work tree with an `origin` remote. The root gets a
`.gitignore` block only if it is itself a git repo.

Run in a git repo → today's single-repo init, unchanged.

### 12. `redqueen init --add-repo <path>`

Appends one repo entry to an existing workspace config using the same
per-repo derivation as §11 (name via `deriveRepoName`), then adds its map
section. Refuses on duplicate name or path. In a legacy-mode install it first lifts the top-level fields
into `repos[0]` (same transform as §13 step 4), which is the in-place
"convert without moving" path. Config edits use the `yaml` package's
`parseDocument` API so comments, key order, tuned phases, pricing, and
`jira discover` output survive untouched.

### 13. `redqueen migrate`

No arguments except `--dry-run` and `--yes`. Run inside an existing install
at `<parent>/<repo>`; moves it to `<parent>`. Fail-fast, nothing touched
until every precondition passes:

1. Preconditions: cwd has `redqueen.yaml` and is a git work tree root;
   `project.directory` resolves to cwd; orchestrator not running (pid file);
   `<parent>/redqueen.yaml` does not exist; `<parent>/.redqueen` does not
   exist; git ≥ 2.17 (for `worktree move`).
2. Print the plan; `--dry-run` stops here.
3. `mkdir <parent>/.redqueen/worktrees`, then for each registered worktree
   under `.redqueen/worktrees/`: `git worktree move <old>
<parent>/.redqueen/worktrees/<id>/<repoName>` (spec worktrees keep their
   `spec-` prefix). A stale `refresh-*` worktree is a crash leftover and is
   removed with `git worktree remove --force`, not moved. Git keeps its
   registration valid, so in-flight tickets survive.
4. Move the remaining `.redqueen/*` entries, `redqueen.yaml`, and `.env` (if
   present) to `<parent>`.
5. Rewrite `<parent>/redqueen.yaml` with `parseDocument`: lift
   `project.buildCommand/testCommand/modules` and
   `sourceControl.config.owner/repo` into `project.repos[0]` with `name` =
   `deriveRepoName(repo)` and `path: ./<dirname>`; set `repos[0].baseBranch`
   from `pipeline.baseBranch`; update `service.workingDirectory` if set.
6. Prefix-swap `worktree_path` in `pipeline_state` to the new nested paths,
   then run the §3 adoption pass against the rewritten config so
   `pipeline_repos` is populated before any helper or `start` runs.
7. If a service unit is installed, reinstall it (the plist/unit bakes in the
   working directory).
8. Print next steps: review the config, `redqueen init --add-repo <path>`
   per sibling, add a source-control webhook on each sibling repo (or one org
   webhook) pointing at the same URL with the same secret, `redqueen start`.

The old repo's `.gitignore` block is left in place; it is harmless.

### 14. Dashboard

Config tab renders `repos[]` (read-only fields as today). Status and workflow
views show a PR list per issue. The header label (`sourceControlRepoLabel`)
becomes the workspace root's basename in workspace mode. No new dashboard
features.

## Error handling

- Unknown `--repo` name, unknown webhook full name, or a `spec meta --repos`
  name not in config: hard error with the list of valid names.
- Coder dispatched with an empty scope: routes to `spec-writing` (skill
  rule), never guesses.
- A repo `path` missing at load time: `ConfigError` naming the entry.
- More than one `repos[].owner` under GitHub App auth: `ConfigError` listing
  the owners.
- A derived repo name that is empty after `deriveRepoName`: `ConfigError`
  naming the source repo.
- `migrate` failure after step 3 begins: the command prints which worktrees
  were moved and the exact `git worktree move` commands to reverse them.
  Steps 4–7 are plain file moves and idempotent rewrites.

## Testing

- `config.test.ts`: legacy synthesis, workspace validation (duplicate names,
  rejected top-level fields, nested modules), `repos[].baseBranch` default,
  `deriveRepoName` (uppercase, `_`, `.`, leading symbols, empty), cross-owner
  rejection under App auth and acceptance under token auth, github-issues
  with an issue repo outside `repos[]`.
- `pipeline-state.test.ts`: `pipeline_repos` CRUD, `setScope` including
  descope-with-open-PR keeps the row, per-row `markPrMerged` with "done only
  on last row" and "descoped row never advances the issue", mirror refresh,
  legacy adoption idempotence including `spec_content`-only rows.
- `rework-transition.test.ts` and `stack.test.ts`: `hasPr` over any in-scope
  row; per-repo blocker gate (satisfied / not applicable / unsatisfied).
- `orchestrator` tests: `dismissStaleReviews` called once per in-scope PR.
- `webhook.test.ts`: `repo` extraction; server routes by full name and drops
  unknown repos.
- `skill-context.test.ts`: `repos` omitted in legacy mode (byte-identical
  snapshot), populated in workspace mode, scalar fallback rules.
- `module-resolver.test.ts`: per-repo resolution.
- `cli/__tests__/migrate.test.ts`: temp fixture with a real git repo, a
  registered worktree, a config with tuned phases and comments; assert
  worktree still registered at the new path, comments preserved, DB paths
  rewritten, dry-run touches nothing.
- `cli/__tests__/init.test.ts`: workspace discovery, `--add-repo` append and
  legacy lift.
- `codebase-map.test.ts`: per-repo sections, edit-me preservation on regen.
- `e2e/full-loop.test.ts`: workspace mode with two in-memory repos, a
  two-repo ticket producing two PRs, `done` only after both merge; and the
  existing single-repo loop unchanged.

## Non-goals (follow-ups, not in this spec)

- Map staleness signal (per-repo SHA, `mapStale` in context, dashboard).
- `redqueen map draft` mapper skill.
- Optional tracker component/label → `repoHints`.
- Prompt-writer appending durable learnings to the map.
- Any vector index or context engine.
- Cross-repo merge ordering or deployment.
- Switching new single-repo installs to the `repos[]` shape.
- Removing the `pipeline_state` mirror columns.

## Suggested implementation order

1. Config + registry + skill context + `codebaseMapPath` wiring, all
   legacy-compatible. No behavior change for existing installs.
2. `pipeline_repos` table, store API, adoption, mirror; `pr`/`pipeline`
   `--repo`; webhook `repo`; reconciler and merge cleanup per row.
3. Skills (all five) and `spec meta --repos`; stack setup per repo.
4. Workspace map, `init` discovery, `--add-repo`, `migrate`.
5. Dashboard and docs.
