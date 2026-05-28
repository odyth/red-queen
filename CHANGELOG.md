# Changelog

All notable changes to Red Queen are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-05-28

The v6 loop release. Rework phases used to re-enter with no memory of
what failed — the coder picked up a code-review rejection as a fresh
task. This release adds explicit prior-phase plumbing so the coder
branches into review-rework or test-rework mode and pulls the
reviewer's actual report from the PR instead of starting over.

### Added

- `pipeline_state.prior_phase` column. Set atomically on every phase
  transition (`UPDATE … SET prior_phase = current_phase, current_phase
  = ?`), surfaced into the skill context as `priorPhase`. The default
  coder skill reads it to choose between fresh-write, review-rework
  (`priorPhase === "code-review"`) and test-rework (`priorPhase ===
  "testing"`) — in rework modes it reuses the existing worktree/PR and
  fetches the latest review with `redqueen pr reviews <pr> --latest`
  to act on blockers, instead of opening a new PR from scratch.
- `redqueen pr reviews <pr> [--latest]` CLI. `--latest` picks the most
  recent `CHANGES_REQUESTED` review (falling back to the newest
  review of any state), so a later human `COMMENTED` or `APPROVED`
  review can't shadow the actionable verdict the coder must rework
  against.
- `phase_sub_iterations` table + `redqueen sub-iter start | complete`
  CLI for skills that want to record granular in-skill progress. The
  unique `(issue_id, phase_name, sub_iter_index)` index protects
  against concurrent inserts racing on `max(index)+1`.
- `pipeline.skipSpecReviewIfReady` fast-path. When the spec-writing
  skill records `openQuestionCount = 0` via `redqueen spec meta` and
  the flag is on, the orchestrator skips the `spec-review` human gate
  and routes straight to its `next` target. The count is single-use —
  cleared after consumption so a stale zero from a previous cycle
  can't fire it again.
- `PhaseDefinition.iterationCounter: "review" | "feedback" | "none"`
  to explicitly bind a phase to a counter. Replaces the brittle
  phase-name string match (`name.includes("review")`); legacy configs
  without the field fall back to the old heuristic.
- `PhaseDefinition.skipRetryOnFailure`. When true, a non-zero worker
  exit skips the global crash-retry and routes immediately via
  `onFail` / `escalateTo`. Default `code-review` sets it: the
  reviewer's `exit 1` is a deliberate "request changes" verdict, not
  a crash, so it no longer triggers `maxRetries` reviewer re-runs (and
  duplicate review posts) per rework cycle.
- `PhaseDefinition.resetReviewIterationsOnPass`. Default `code-review`
  sets it: once the review loop closes successfully, a downstream
  testing failure re-enters the loop with a fresh iteration budget
  rather than the count accumulated from the prior round.

### Changed

- **Breaking (data loss on first boot)**: the `plan-review` phase was
  removed from the default pipeline. On first start of any 0.6 build,
  an irreversible migration drops these columns from `pipeline_state`:
  `plan_review_verdict`, `plan_review_rating`, `plan_review_blockers`,
  `plan_review_open_questions`, `plan_review_recorded_at`. Existing
  data in these columns is permanently lost. If you need it, snapshot
  `.redqueen/redqueen.db` before upgrading.
- Default reviewer skill now signals routing via exit code: `exit 1`
  on `request-changes`, `exit 0` on approve. Combined with
  `skipRetryOnFailure` on `code-review` this means one reviewer run
  per rework cycle, one posted review.
- Default tester skill now appends a per-run results comment to the PR
  on every exit (pass, route-to-coding, or Blocked) so the PR carries
  the full test history.
- Orchestrator only re-reads the spec from the tracker on the first
  dispatch of a phase that's a direct successor of a human gate
  (`next` or `rework` target). Mid-automation phases skip the
  round-trip.
- Worker output truncation caps raised from 500 to 2000 chars so the
  audit log carries enough of the worker's stdout to diagnose failures
  without tailing logs.

## [0.4.0] - 2026-05-08

### Changed

- **Breaking (Jira config)**: missing `phaseMapping` entries in
  `redqueen.yaml` are now startup errors, not warnings. Before,
  `redqueen start` would print a warning and continue; now it
  refuses to start until every phase in the graph has a mapping.
  The goal is to surface typos at boot instead of letting
  `setPhase` fail silently mid-pipeline. The default phase graph
  added `spec-awaiting-info` in this release, so upgraders on Jira
  need to add a `phaseMapping.spec-awaiting-info` entry (run
  `redqueen jira discover` to auto-resolve it) before starting.
- **Breaking (CLI output)**: `redqueen pr comments <pr>` now returns
  only the comments on unresolved review threads. Previously it
  returned every review comment on the PR, including those on
  resolved threads. Pass `--include-resolved` to restore the old
  behavior. Scripts that parsed the old output will see fewer
  results after upgrade.
- **Breaking (phase schema)**: `PhaseDefinition.priority` has been
  removed and the phase schema is now strict — unknown keys are
  rejected at load time. Custom `redqueen.yaml` phase entries that
  carry `priority: N` will fail startup with a schema error. Delete
  the field; queue ordering is now derived from phase topology, not
  per-phase priority.
- Phase definitions gain an optional `requiresPr` field. When set,
  the orchestrator only auto-transitions into that phase (and the
  pr-feedback webhook only enqueues it) when the PR-existence
  matches — `requiresPr: true` needs a PR, `requiresPr: false`
  requires no PR. Previously this routing was hardcoded to the
  default phase names `code-feedback` / `spec-feedback`, silently
  breaking customized phase graphs. The default phases now carry
  the right `requiresPr` values, so no config change is required
  for the default setup.
- GitHub review-thread fetches now paginate per-thread comments
  past the initial 100, so hot PRs with very long threads no
  longer silently truncate.

### Fixed

- Auto-transition from a human gate into its rework phase no longer
  rolls back if `assignToAi` fails after `setPhase` succeeds. The
  assignee is an ops signal; the phase change is the correctness
  requirement, so we keep it and audit the assignToAi failure
  instead of marking the task stale.
- Orchestrator only re-reads the spec from the tracker when the
  dispatching phase is a direct successor of a human gate (its
  `next` or `rework` target). Previously every non-spec-writing
  dispatch made an extra tracker round-trip, burning rate-limit
  budget on phases where the human has no opportunity to edit.

## [0.3.3] - 2026-05-06

### Fixed

- Jira client now forces `Accept-Language: en` on every request so
  error messages surface in English regardless of the service
  account's locale. Localized error text from non-English tenants
  was breaking the adapter's error-message pattern matching.

## [0.3.2] - 2026-05-06

### Fixed

- macOS: `service start` after `service stop` again reloads and starts
  the LaunchAgent. 0.3.1 removed the post-bootstrap `kickstart` on a
  race theory that didn't hold up; in practice `launchctl bootstrap`
  exits 0 but silently no-ops on some macOS releases, so with no
  `kickstart` the job never ran and the 5s postcondition poll timed
  out. `start` and `restart` now verify the job actually registered
  after `bootstrap` (throwing a descriptive error if not) and then
  explicitly `kickstart` the job. `launchctl` stderr is now included
  in the thrown error when `bootstrap` itself fails.

## [0.3.1] - 2026-05-06

Patch release. `redqueen service start` on macOS after a prior
`redqueen service stop` reported success but the LaunchAgent never
actually ran. Root cause: `launchctl bootstrap` exits 0 even when the
plist fails to load, and the follow-up `kickstart` raced with the
bootstrap-driven RunAtLoad start. Upgrade path is in place — just
`npm install -g redqueen@latest` and re-run your existing
`service start`.

### Fixed

- macOS: `service start` on an unloaded job now bootstraps only (no
  follow-up kickstart) and lets the plist's `RunAtLoad=true` start
  the job. When the job is already loaded, `start` kickstarts as
  before. Fixes the "Service started" false-positive when bootstrap
  silently failed.
- `service start`, `restart`, and `install` now poll `service status`
  for up to 5s and throw a descriptive error (pointing at the stderr
  log) if the service never reaches running state. No more commands
  returning success while the dashboard is unreachable.
- Linux: `service start`, `restart`, and `install` get the same
  postcondition poll for symmetry.

## [0.3.0] - 2026-05-05

UX polish release from AlignSmart dogfood feedback. Five install-time
traps the 0.2.0 rollout hit, all fixed here; plus a new
`redqueen jira discover` command that auto-fills the custom field IDs
and phase option mappings that `redqueen init` leaves as placeholders.
No schema changes, no breaking changes — `stop → npm install -g
redqueen@latest → service install → start` is the upgrade path.

### Added

- `redqueen jira discover` queries Jira's `/rest/api/3/field` endpoint,
  selects single-select Phase and textarea Spec custom fields, fetches
  the phase options, and patches `redqueen.yaml` with the resolved
  IDs. Levenshtein-fuzzy match for phase-option pairing. `--yes` for
  non-interactive CI, `--dry-run` to inspect the diff.
- `redqueen service install` auto-detects the `claude` binary via
  `which` and writes the absolute path to `pipeline.claudeBin`. launchd
  and systemd user services ship with a minimal PATH that doesn't
  include nvm / asdf / homebrew by default, so the service could find
  Red Queen but not Claude without this.
- `redqueen init` now prints
  ``Next: run `redqueen jira discover` `` in the post-install banner
  for Jira projects.

### Fixed

- `redqueen service start` after `redqueen service stop` on macOS no
  longer fails with `Could not find service`. `stop` calls
  `launchctl bootout`, which fully unloads the job; `kickstart` can't
  recover an unloaded job. `start` and `restart` now detect the
  unloaded state via `launchctl print` and re-bootstrap before
  kickstarting.
- `.env` is now loaded by every CLI command that reads config — not
  just `redqueen start`. Commands like `redqueen status` and
  `redqueen service` no longer fail with `Config references
  $JIRA_TOKEN but the environment variable is not set` unless the user
  first ran `source .env`. Centralized in
  `loadConfigFromProject(startDir)` so future commands can't reintroduce
  the bug.
- Dashboard **Stop** button no longer renders an optimistic Start
  button that would POST to a now-dead server. After Stop the partial
  shows an instruction block:
  ``Run `redqueen service start` in a terminal to bring it back.``

### Changed

- README rewritten around the Jira + service + dashboard product
  surface. Structured as: install → Jira quickstart → alternative
  GitHub Issues path → dashboard tabs → service management → config →
  verification checklist → troubleshooting. Removed preview-era
  version claims in prose; version lives in `package.json` and
  `CHANGELOG.md`.
- `levenshtein()` promoted to `src/core/strings.ts` so both config
  validation and `jira discover` share the implementation.

## [0.2.0] - 2026-05-04

Dogfood feedback release. AlignSmart's hand-patched 0.1.3 install
revealed four Jira polling bugs, four product gaps, and a need to
self-service pipeline config without shelling into the host. 0.2.0
fixes the bugs, adds a first-class service installer, and grows the
dashboard into a full control plane.

### Fixed

- Jira adapter migrated from `POST /rest/api/3/search` to
  `GET /rest/api/3/search/jql` — the old endpoint was deprecated and
  AlignSmart's tenant refused it.
- Jira `Issue.id` now uses the human-readable key (`AS-42`) instead of
  the numeric id. All downstream queue + audit references are
  key-based, so task logs are finally readable.
- Reconciler excludes Done/Closed issues via `statusCategory != Done`
  in the JQL. Closed tickets with stale AI Phase values no longer get
  re-queued.
- Reconciler skips mid-pipeline phases when there's no local pipeline
  record — prevents a fresh install from blindly enqueuing an issue
  already past `new-ticket`.
- Webhook `assignment-change` and `phase-change` handlers now honor the
  same bootstrap guard: non-entry Jira phases on a fresh DB are
  skipped with an audit entry rather than dispatched as `spec-writing`.

### Added

- `redqueen service install | start | stop | restart | status | uninstall`
  CLI commands generate and drive a macOS LaunchAgent or Linux systemd
  `--user` unit. A wrapper script (`.redqueen/run-redqueen.sh`)
  sources `.env` at runtime so the generated unit/plist never contains
  secret values.
- `service` config block: `enabled`, `name` (default
  `sh.redqueen.<projectDirHash8>`), `workingDirectory`, `envFile`,
  `stdoutLog`, `stderrLog`, `restart`.
- Dashboard refactor to HTMX + server-rendered partials. Vendored
  `htmx.min.js`, no build step. Tabs: Status, Service, Config, Skills,
  Workflow. SSE stream unchanged.
- Dashboard service controls: start / stop / restart buttons wired to
  the platform service manager. UI greys out controls when the service
  isn't installed.
- Dashboard config editor: raw YAML textarea with validate / save /
  env-ref panel. Save triggers `Orchestrator.reload(newConfig)` and
  surfaces `applied` / `restartRequired` banners.
- Dashboard skills manager: lists bundled + user skills with origin
  tags and referenced-by cross-check. User overrides live at
  `.redqueen/skills/<name>/SKILL.md`; the bundled tree is never
  written. Disable toggle via `skills.disabled`.
- Dashboard workflow editor: phase list with add / remove / reorder,
  skill dropdown populated from the skills API, validate + save.
  Rejects with HTTP 409 when any ready or working tasks are queued;
  UI surfaces live queue count via SSE.
- `Orchestrator.reload(newConfig)` validates, rebuilds the phase
  graph, mutates shared `RuntimeState` in place so every subsystem
  (poller, reconciler, webhook, dashboard) observes the swap without
  being torn down. Sections split into `applied` vs `restartRequired`.
- `skills.disabled: string[]` config key. Load-time check in
  `parseConfig` throws if any phase references a disabled skill;
  `resolveSkillPath` returns `null` for disabled skills as a
  second line of defense.
- `PhaseGraph.getEntryPhases()` derives entry phases from graph
  structure (phases not referenced as `next`/`onFail`/`rework`/
  `escalateTo` of any other phase). No schema flag.
- Secret-leak guard on config save: blocks literal values of
  `JIRA_TOKEN`, `GITHUB_PAT`, `GITHUB_APP_PRIVATE_KEY`, and any env
  key ending in `_TOKEN` / `_SECRET` / `_PASSWORD` / `_PAT` /
  `_PRIVATE_KEY` whose value is ≥ 8 chars. `${VAR}` placeholders pass
  through. Rejection message: `literal value of ${<VAR>} detected;
  use ${<VAR>} instead`.

### Changed

- Every subsystem now holds a shared mutable `RuntimeState` instead of
  a direct `PhaseGraph` reference. Enables live config reload without
  teardown. Audit list: `orchestrator`, `poller`, `reconciler`,
  `webhook`, `dashboard`.
- `TaskQueue.getOpenCount()` returns `{ ready, working }` so the
  workflow editor can pre-check before accepting a save.

## [0.1.3] - 2026-05-04

### Fixed

- `redqueen init` with webhooks enabled now produces a config that
  passes `redqueen start` validation without manual editing. Previously
  init wrote `pipeline.webhooks.secret` while the validator expected
  adapter-scoped `issueTracker.config.webhookSecret` and
  `sourceControl.config.webhookSecret` — enabling webhooks through init
  would always fail to start.

### Added

- `pipeline.webhooks.paths.issueTracker` and `pipeline.webhooks.paths.sourceControl`
  are now configurable. Defaults remain `/webhook/issue-tracker` and
  `/webhook/source-control`. Paths must start with `/` and must not
  collide.
- `pipeline.webhooks.publicBaseUrl` (optional). When set, the `start`
  banner prints the full public webhook URLs for issue tracker and
  source control — making the "paste this into Jira/GitHub" step
  explicit.
- `redqueen init` now prompts for `publicBaseUrl` and custom webhook
  paths when webhooks are enabled, and scaffolds per-adapter secrets
  (`JIRA_WEBHOOK_SECRET` + `GITHUB_WEBHOOK_SECRET`) in `.env` instead
  of the unused `REDQUEEN_WEBHOOK_SECRET`.

## [0.1.2] - 2026-04-29

### Fixed

- `redqueen --version`, the `start` banner, and HTTP `User-Agent`
  headers no longer print a stale hardcoded version. All now read
  from `package.json` at runtime.

### Changed

- CI and release workflows bumped from `actions/checkout@v4` +
  `actions/setup-node@v4` to `@v5` to silence the Node 20 deprecation
  warning.

## [0.1.1-rc.1] - 2026-04-29

Release-automation smoke test. No functional changes.

## [0.1.0] - 2026-04-29

Initial preview release.

### Added

- Deterministic orchestrator core (`RedQueen`) with phase state
  machine, worker dispatch, crash recovery, and startup reconciliation.
- SQLite-backed task queue with priority-positional insertion and
  deduplication.
- Pipeline state, orchestrator state, and audit log stores (dual-write
  flat file + SQLite).
- Phase 2 contracts: `IssueTracker`, `SourceControl`, `AuditLogger`,
  `TaskQueue` interfaces.
- Embedded web dashboard (SSE live updates) and optional webhook server
  on a shared HTTP port.
- CLI commands: `init`, `start`, `stop`, `status`, plus tracker-neutral
  helpers (`issue`, `spec`, `pr`, `pipeline`).
- Five default skill templates: prompt-writer, coder, reviewer, tester,
  comment-handler.
- Interactive `init` flow with language detection, codebase map
  generation, and curated reference templates (spec, coding standards,
  review checklist).
- Integration adapters: Jira (API token auth, ADF converter, custom
  field mapping), GitHub Issues (label-based phase storage, marker
  comment spec storage), GitHub source control (Octokit, PAT + BYO App
  auth strategies, webhook HMAC validation).
- `${ENV_VAR}` interpolation and `.env` auto-load in config loader.
- End-to-end test harness with in-memory adapters and a fake Claude
  worker.
- Release automation via tag push + npm OIDC trusted publishing.
- `examples/github-issues/` and `examples/jira-github/` reference
  configs.

### Known limitations (preview)

- Linear / Bitbucket adapters not yet implemented.
- Single-worker execution only (no parallel workers).
- Tunnel/reverse-proxy setup for webhooks is the user's responsibility
  — no bundled helper.
- Stall detection for workers uses `ps` and is Unix-only; Windows
  workers still get the hard timeout.
- Workflow tested against Claude Code only; other AI CLIs not yet
  supported.
