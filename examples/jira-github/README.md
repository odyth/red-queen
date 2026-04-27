# Example: Jira + GitHub source control

## Overview

A production-grade Red Queen setup using Jira Cloud as the issue
tracker and GitHub as the source control provider, authenticated with a
BYO (Bring Your Own) GitHub App. This configuration matches the
prototype Red Queen was extracted from.

## What this demonstrates

- Jira custom fields for phase and spec storage.
- Explicit phase → Jira option ID mapping.
- GitHub App auth (short-lived installation tokens, rotated
  automatically).
- Separate webhook secrets per adapter.

## Prerequisites

- A Jira Cloud instance with a service account, an API token, and
  custom fields for phase (dropdown) and spec (long text). The option
  IDs in `phaseMapping` must match your dropdown.
- A GitHub App registered in your org with the installation ID and a
  downloaded private key (`./redqueen-app.private-key.pem` by default).
  See [`src/integrations/github/README.md`](../../src/integrations/github/README.md)
  for the walkthrough.

## Usage

```bash
cp examples/jira-github/redqueen.yaml redqueen.yaml
cp examples/jira-github/.env.example .env
# edit redqueen.yaml to set owner/repo/cloudId/field IDs/option IDs
# drop the GitHub App private key at ./redqueen-app.private-key.pem
# populate .env
redqueen start
```

## See also

- [`src/integrations/jira/README.md`](../../src/integrations/jira/README.md)
- [`src/integrations/github/README.md`](../../src/integrations/github/README.md)
