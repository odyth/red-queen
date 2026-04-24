# GitHub Issues Issue Tracker Adapter

Red Queen integration for GitHub Issues — implements the `IssueTracker`
interface on top of the GitHub REST API (Octokit). Pairs with the
`github` source control adapter.

## Configuration

```yaml
issueTracker:
  type: github-issues
  config:
    owner: odyth
    repo: red-queen
    auth:
      type: pat
      token: ${GITHUB_PAT}
    webhookSecret: ${GITHUB_WEBHOOK_SECRET} # optional
```

Put the real secrets in `.env`:

```
GITHUB_PAT=ghp_...
GITHUB_WEBHOOK_SECRET=....
```

The adapter **must** be paired with a `github` source control adapter
using the same owner/repo and the same auth strategy. Pairing is
enforced at startup.

## How phases work

There's no native phase field on GitHub Issues. Red Queen uses labels:

- `rq:phase:<name>` — the issue's current pipeline phase.
- `rq:active` — "AI is actively working on this" signal (because
  GitHub doesn't let apps/PATs be issue assignees reliably).

Labels are **self-healing**: if a phase label doesn't exist, the adapter
creates it with a muted color. You don't need to pre-create labels in
config.

## Phase transitions from humans

To move an issue forward manually, change its `rq:phase:*` label.
Red Queen picks up the change via polling (or webhook) and reacts.

Example human workflow on spec review:

1. Issue is in `rq:phase:spec-review` — human reads the spec.
2. Human removes `rq:phase:spec-review`, adds `rq:phase:coding`.
3. Red Queen sees the change; starts coding.

## Spec storage

Specs live in a **marker comment** on the issue. The first line is
the literal string `<!-- redqueen:spec -->`; everything after it is
the spec body in markdown.

The issue body itself is never modified — that's the user's space.

## Assigning the human reviewer

When a phase transitions to a human gate, the adapter:

1. Removes `rq:active`.
2. Posts a comment `@<reporter> needs your review (phase: <phase>)`.
3. Tries to add the reporter as a native assignee. If that fails
   (permissions, org rules), the comment is the fallback notification.

## Token scopes

Same as the `github` adapter:

- Fine-grained PAT: `Contents`, `Issues`, `Pull requests`, `Workflows`,
  `Metadata` (all read+write except Metadata which is read).
- Classic PAT: `repo` covers all of these.

## Webhook setup

Wire webhooks to `/webhook/issue-tracker` and enable these event types:

- `issues` (for label-based phase changes)
- `issue_comment` (for PR feedback via PR comments on the issue)

See the `github` source control README for the Cloudflare Tunnel recipe
— same tunnel, same webhook, separate endpoint paths.

## Known limitations (Phase 5)

- One owner/repo per Red Queen instance.
- No native "workflow transitions" — `transitionTo` is a no-op.
- No attachment listing — GitHub inlines attachments as CDN URLs in
  comment bodies.
- Duplicate marker comments (produced by a race) are tolerated: the
  most recent wins. Delete duplicates manually if desired.
