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

| Field             | Type                                                           | Notes                                                                  |
| ----------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `issueId`         | string                                                         | External ref (e.g. `PROJ-123`, `#456`). Opaque to adapters.            |
| `phaseName`       | string                                                         | e.g. `spec-writing`, `spec-feedback`, `coding`. Skills branch on this. |
| `phaseLabel`      | string                                                         | Human-readable label.                                                  |
| `skillName`       | string                                                         | Resolved skill name.                                                   |
| `buildCommands`   | string                                                         | From `project.buildCommand`.                                           |
| `testCommands`    | string                                                         | From `project.testCommand`.                                            |
| `repoOwner`       | string                                                         | May be `""` if the adapter does not use the concept.                   |
| `repoName`        | string                                                         | Same.                                                                  |
| `baseBranch`      | string                                                         | `origin/<name>` form (e.g. `origin/main`).                             |
| `branchPrefix`    | string                                                         | e.g. `feature/`, `bugfix/`. Pre-resolved from issue type.              |
| `module`          | `{buildCommand, testCommandTargeted, testCommandFull} \| null` | Per-module commands when configured, else `null`.                      |
| `branchName`      | string \| null                                                 | `null` before coding creates a branch.                                 |
| `prNumber`        | number \| null                                                 | `null` before coding creates a PR.                                     |
| `specContent`     | string \| null                                                 | `null` during spec-writing; populated thereafter.                      |
| `priorContext`    | string \| null                                                 | Handoff summary from the previous phase.                               |
| `iterationCount`  | number                                                         | Feedback / review iterations for the relevant phase, else `0`.         |
| `maxIterations`   | number                                                         | Defaults to 3.                                                         |
| `codebaseMapPath` | string \| null                                                 | Path to `.redqueen/codebase-map.md` when it exists.                    |
| `projectDir`      | string                                                         | Absolute path to the project root.                                     |

## What skills can read

- Files under `projectDir` via Glob / Grep / Read
- `.redqueen/references/*.md` (if present)
- `codebaseMapPath` (if set)
- Output from `redqueen` CLI helpers (e.g. `redqueen issue get`, `redqueen pr diff`)
- Output from standard `git` commands

## What skills can write

- Files under `projectDir` (including git worktrees they create)
- `redqueen spec set`, `redqueen issue comment`, `redqueen pr create`, `redqueen pr review`, `redqueen pr reply`
- `redqueen pipeline update` (branch / PR / worktree metadata)
- Git commits and pushes on branches they own

## Tracker neutrality

Skills do **not** call tracker-specific APIs (Jira MCP tools, `gh` CLI,
GitHub REST). All tracker and source-control operations go through
`redqueen` helper subcommands. Swapping adapters (e.g. `jira` →
`github-issues`) never requires a skill edit.
