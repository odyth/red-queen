# Changelog

All notable changes to Red Queen are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  `Next: run \`redqueen jira discover\`` in the post-install banner
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
  `Run \`redqueen service start\` in a terminal to bring it back.`

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
