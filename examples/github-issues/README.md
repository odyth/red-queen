# Example: GitHub Issues + GitHub source control

## Overview

A minimal Red Queen setup using GitHub Issues as the issue tracker and
GitHub as the source control provider, authenticated with a single
Personal Access Token.

## What this demonstrates

- The simplest possible adapter pairing — one PAT, one repo, no Jira.
- Label-based phase storage (`rq:phase:<name>`).
- Polling-only operation (webhooks are optional).

## Prerequisites

- A GitHub repo you own or have admin access to.
- A fine-grained PAT with Contents, Issues, Pull requests, Workflows
  (read+write), and Metadata (read) scoped to that repo. See
  <https://github.com/settings/personal-access-tokens/new>.

## Usage

```bash
cp examples/github-issues/redqueen.yaml redqueen.yaml
cp examples/github-issues/.env.example .env
# edit redqueen.yaml to set owner/repo, and .env to add your PAT
redqueen start
```

## See also

[`src/integrations/github-issues/README.md`](../../src/integrations/github-issues/README.md)
for label conventions, webhook setup, and troubleshooting.
