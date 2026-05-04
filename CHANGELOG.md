# Changelog

All notable changes to Red Queen are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- README overhaul: plain-English TL;DR, customization section, FAQ,
  troubleshooting, named competitor comparison, For-AI-agents block.
- `llms.txt` at repo root for AI crawler discoverability.
- Inline SVG logo + tagline in dashboard header.
- Expanded `package.json` keywords for discoverability.
- Brand assets (logo, social card) under `assets/brand/` and tagline
  wired into README and dashboard header.

## [0.1.3] - YYYY-MM-DD

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
