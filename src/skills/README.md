# Red Queen Skills

This directory ships the five default skill templates the orchestrator
dispatches during a normal SDLC run:

- `prompt-writer/` — writes specs (fresh + revision flows)
- `coder/` — implements the spec, opens a PR
- `reviewer/` — reviews the PR against the spec and coding standards
- `tester/` — verifies build + tests locally and in CI
- `comment-handler/` — addresses PR review feedback iteratively

Each skill is a single `SKILL.md` file. The orchestrator reads it, prepends a
`yaml context` fenced block with structured state, and hands the resulting
prompt to a Claude Code worker via stdin. Skills are natural-language
instructions — they do not run as Node code.

## User overrides

A user can override any built-in skill by placing a file at
`.redqueen/skills/<skill-name>/SKILL.md` in their project. The orchestrator
prefers the user file when it exists, falling back to the built-in.

## Skill context contract (read before authoring a custom skill)

The orchestrator injects a `yaml context` block at the top of every skill
prompt. The fields below are stable across minor version bumps — new fields
may be added, but existing fields will not be renamed or have their types
changed without a major version bump.

| Field             | Type                                                           | Notes                                                                                                                                                                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issueId`         | string                                                         | External ref (e.g. `PROJ-123`, `#456`). Opaque to adapters.                                                                                                                                                                                                                                                                |
| `phaseName`       | string                                                         | e.g. `spec-writing`, `spec-feedback`, `coding`. Skills branch on this.                                                                                                                                                                                                                                                     |
| `phaseLabel`      | string                                                         | Human-readable label.                                                                                                                                                                                                                                                                                                      |
| `skillName`       | string                                                         | Resolved skill name.                                                                                                                                                                                                                                                                                                       |
| `buildCommands`   | string                                                         | From `project.buildCommand`.                                                                                                                                                                                                                                                                                               |
| `testCommands`    | string                                                         | From `project.testCommand`.                                                                                                                                                                                                                                                                                                |
| `repoOwner`       | string                                                         | May be `""` if the adapter does not use the concept.                                                                                                                                                                                                                                                                       |
| `repoName`        | string                                                         | Same.                                                                                                                                                                                                                                                                                                                      |
| `baseBranch`      | string                                                         | `origin/<name>` form (e.g. `origin/main`).                                                                                                                                                                                                                                                                                 |
| `branchPrefix`    | string                                                         | e.g. `feature/`, `bugfix/`. Pre-resolved from issue type.                                                                                                                                                                                                                                                                  |
| `module`          | `{buildCommand, testCommandTargeted, testCommandFull} \| null` | Per-module commands when configured, else `null`.                                                                                                                                                                                                                                                                          |
| `branchName`      | string \| null                                                 | `null` before coding creates a branch.                                                                                                                                                                                                                                                                                     |
| `prNumber`        | number \| null                                                 | `null` before coding creates a PR.                                                                                                                                                                                                                                                                                         |
| `specContent`     | string \| null                                                 | `null` during spec-writing; populated thereafter.                                                                                                                                                                                                                                                                          |
| `priorContext`    | string \| null                                                 | Handoff summary from the previous phase.                                                                                                                                                                                                                                                                                   |
| `iterationCount`  | number                                                         | Feedback / review iterations for the relevant phase, else `0`.                                                                                                                                                                                                                                                             |
| `maxIterations`   | number                                                         | Defaults to 3.                                                                                                                                                                                                                                                                                                             |
| `codebaseMapPath` | string \| null                                                 | Path to `.redqueen/codebase-map.md` when it exists.                                                                                                                                                                                                                                                                        |
| `projectDir`      | string                                                         | Absolute path to the project root.                                                                                                                                                                                                                                                                                         |
| `stackBlockedBy`  | string[] _(omitted when absent)_                               | Stacked issues only: direct blocker issue ids. Absent otherwise — non-stacked prompts are byte-identical to pre-stack versions.                                                                                                                                                                                            |
| `stackPrBase`     | string _(omitted when absent)_                                 | Present only with `stackBlockedBy`: the branch the PR must target.                                                                                                                                                                                                                                                         |
| `repos`           | `SkillContextRepo[]` _(omitted in legacy mode)_                | Workspace mode only: every configured repo, in config order — `{name, path, baseBranch, buildCommand, testCommand, inScope, branchName, prNumber, terminalPrNumber, mergeCompleted, module, stackPrBase?}`. `path` is absolute. `inScope` is `false` until the prompt-writer sets scope with `redqueen spec meta --repos`. |

**Workspace mode:** when `repos` is absent, keep the legacy single-repo
behavior. When `repos` is present, `buildCommands`, `testCommands`,
`baseBranch`, `repoOwner`, `repoName`, `module`, `branchName`, `prNumber`, and
`stackPrBase` are **deprecated** and describe only the first in-scope repo (or
`repos[0]` before scope is set). Multi-repo-aware skills loop over `repos`
instead. `projectDir` is the workspace root, which is not itself a git
repository — run git with `-C <repo.path>` or inside a worktree.

Only the prompt-writer decides scope and records it with
`redqueen spec meta <issueId> --open-questions N --repos <names>` (a
comma-separated list of configured repo names). The other skills use
`repos[]` entries with `inScope: true`; they never infer additional repos
from paths or keywords. Report orphaned PRs (`inScope: false` with a non-null
`prNumber`) for human attention.

Each repo's `mergeCompleted` is `true` only when that repo merged in the
current issue cycle. During partial-merge rework, skip completed repos so
their PRs and cleaned worktrees are not recreated. `terminalPrNumber` is
the historical terminal PR number (`number | null`) and can remain set
after reopening; it does not establish current-cycle completion. Missing
rows start with `mergeCompleted: false` and `terminalPrNumber: null`.
An unfinished in-scope row with `prNumber: null` still needs a PR; a completed
row must be skipped during mutation and testing, even if its PR or worktree
metadata has already been cleaned up.

**Stacked issues:** when `stackBlockedBy` is present, worktree setup goes
through `redqueen stack setup <issueId>` (or `--spec` for the prompt-writer's
throwaway exploration worktree) instead of raw git — it branches from base and
merges unmerged ancestor branches in topo order. Never rebase a stacked
worktree. In workspace mode `stack setup` loops unfinished in-scope repos
(`inScope: true`, `mergeCompleted: false`), or every configured repo with
`--spec`. Successful JSON output lists one entry per prepared repo under
`repos`. A merge conflict (exit 2) names the conflicting `repo`; `repos`
contains only earlier successful entries, so later repos may still need
spec worktrees before exploration.

**Worktree layout:** legacy mode uses `${projectDir}/.redqueen/worktrees/<issueId>`
(`spec-<issueId>` for exploration). Workspace mode nests one directory per repo:
`${projectDir}/.redqueen/worktrees/<issueId>/<repo.name>` and
`${projectDir}/.redqueen/worktrees/spec-<issueId>/<repo.name>`. The workspace
root is not a git repository — run raw git as `git -C "<repo.path>" …` or inside
a worktree.

## What skills can read

- Files under `projectDir` via Glob / Grep / Read (workspace mode: under each
  `repos[].path`, plus `<repo.path>/CLAUDE.md` and `<repo.path>/AGENTS.md`)
- `.redqueen/references/*.md` (if present)
- `codebaseMapPath` (if set): in workspace mode, read the workspace map first,
  then each candidate repo's `CLAUDE.md` and `AGENTS.md` when present (about
  200 lines each) before grepping candidate repos. The prompt-writer creates
  exploration worktrees for every configured repo, even when only some are
  candidates, and removes all of them afterward.
- Output from `redqueen` CLI helpers (e.g. `redqueen issue get`, `redqueen pr diff`)
  — every `redqueen pr` subcommand passes `--repo <name>` in workspace mode
- Output from standard `git` commands

## What skills can write

- Files under `projectDir` (including git worktrees they create)
- `redqueen spec set`, `redqueen spec meta` (`--repos <names>` records which
  repos a ticket touches in workspace mode), `redqueen issue comment`,
  `redqueen pr create`, `redqueen pr review`, `redqueen pr reply` — every
  `pr` subcommand passes `--repo <name>` in workspace mode
- `redqueen pipeline update` (branch / PR / worktree metadata; `--repo <name>`
  in workspace mode)
- `redqueen stack setup` (stacked-issue worktree assembly, per repo)
- Git commits and pushes on branches they own

## Tracker neutrality

Skills do **not** call tracker-specific APIs (Jira MCP tools, `gh` CLI,
GitHub REST). All tracker and source-control operations go through
`redqueen` helper subcommands. Swapping adapters (e.g. `jira` →
`github-issues`) never requires a skill edit.
