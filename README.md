# Red Queen

[![CI](https://github.com/odyth/red-queen/actions/workflows/ci.yml/badge.svg)](https://github.com/odyth/red-queen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**The Red Queen doesn't think. It commands.**

Deterministic orchestrator for AI coding agents — zero tokens, full SDLC pipeline, human-in-the-loop gates.

## What Is Red Queen?

Red Queen is a state machine that orchestrates AI coding agents through a complete software development lifecycle. It dispatches isolated AI workers to write specs, implement code, review PRs, run tests, and address feedback — all without spending a single AI token on orchestration.

The orchestrator is ~600 lines of deterministic logic. No black box. No AI deciding what to do next. Just a state machine that commands workers and enforces human checkpoints.

## Key Features

- **Zero-token orchestration** — The state machine is pure logic. Cheaper, faster, and fully debuggable compared to AI-driven orchestrators.
- **Isolated skill workers** — Each phase (spec writing, coding, review, testing, feedback) runs a purpose-built prompt in isolation. Focused prompts outperform kitchen-sink mega-agents.
- **Human-in-the-loop gates** — Human review checkpoints are first-class workflow, not an afterthought. You stay in control.
- **Issue tracker integration** — Bidirectional sync with Jira and GitHub Issues. Work flows from your issue tracker through the pipeline and back.
- **Retry with escalation** — Failed phases retry up to 3 times, then escalate to a human. No infinite loops.
- **Webhook + polling** — Optional webhook server for instant response, with polling fallback that works out of the box.

## Pipeline

```
Spec Writing (AI) → Spec Review (HUMAN) → Coding (AI) → Code Review (AI) → Testing (AI) → Human Review (HUMAN)
                                              ↑                   |              |
                                              └───────────────────┘              |
                                              (rework, max 3 iterations)         |
                                                                                 |
                                          Addressing Feedback (AI) ←── Human PR feedback
```

## Quick Start

```bash
npx redqueen init      # Scaffold config
npx redqueen start     # Run the orchestrator
npx redqueen status    # Health check
npx redqueen stop      # Stop services
```

## Architecture

```
src/
├── cli/               # CLI commands (init, start, stop, status)
├── core/              # State machine, queue, config
├── integrations/      # Issue tracker & source control adapters
│   ├── jira/          # Jira adapter
│   ├── github/        # GitHub adapter
│   └── github-issues/ # GitHub Issues as issue tracker
├── skills/            # Default skill templates (user-overridable)
└── webhook/           # Optional webhook server
```

Red Queen uses an adapter pattern for integrations. All issue trackers implement a common `IssueTracker` interface, making it straightforward to add support for Linear, Shortcut, or any other tracker.

## How Is This Different?

Most AI coding tools use AI to orchestrate AI — spending tokens to decide what to do next. Red Queen takes the opposite approach:

| | Red Queen | AI-Driven Orchestrators |
|---|---|---|
| Orchestration cost | Zero tokens | Tokens on every decision |
| Debuggability | Read the state machine | Hope the LLM explains itself |
| Predictability | Deterministic | Probabilistic |
| Skill isolation | Focused, purpose-built prompts | Shared context, kitchen-sink prompts |
| Human oversight | Built-in gates | Bolt-on afterthought |

## Integrations

| Integration | Status |
|---|---|
| Jira | ✅ Supported |
| GitHub Issues | ✅ Supported |
| GitHub (source control) | ✅ Supported |
| Linear | Planned |

## Requirements

- Node.js >= 24
- An AI coding agent CLI (e.g., Claude Code)
- An issue tracker (Jira or GitHub Issues)

## License

MIT — see [LICENSE](LICENSE).

## Links

- **Website:** [redqueen.sh](https://redqueen.sh)
- **Issues:** [GitHub Issues](https://github.com/odyth/red-queen/issues)
