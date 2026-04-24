# GitHub Source Control Adapter

Red Queen integration for GitHub — implements the `SourceControl` interface
for branches, pull requests, reviews, check runs, and webhooks.

## Configuration

```yaml
sourceControl:
  type: github
  config:
    owner: odyth
    repo: red-queen
    auth:
      type: pat
      token: ${GITHUB_PAT}
    webhookSecret: ${GITHUB_WEBHOOK_SECRET} # optional
```

The `token` and `webhookSecret` values use `${VAR}` interpolation — put
the actual secrets in `.env`:

```
GITHUB_PAT=ghp_...
GITHUB_WEBHOOK_SECRET=....
```

## Token scopes

### Fine-grained PAT (recommended)

- **Contents**: Read and write
- **Issues**: Read and write
- **Pull requests**: Read and write
- **Workflows**: Read and write (required for `getChecks`)
- **Metadata**: Read (default)

Create one at <https://github.com/settings/personal-access-tokens/new>.

### Classic PAT (alternative)

- `repo` (full repo access) covers everything above.

## Webhook setup (optional)

Webhooks reduce polling latency from ~30s to ~1s. Optional — Red Queen's
poller keeps everything working without them.

1. **Expose Red Queen to the internet.** Easiest path is Cloudflare Tunnel:
   ```
   cloudflared tunnel --url http://localhost:4400
   ```
   The CLI prints a public URL like `https://<random>.trycloudflare.com`.
2. In your repo: **Settings → Webhooks → Add webhook**.
   - Payload URL: `<public-url>/webhook/source-control`
   - Content type: `application/json`
   - Secret: the same string you put in `GITHUB_WEBHOOK_SECRET`.
   - Events: `issues`, `issue_comment`, `pull_request`,
     `pull_request_review`, `pull_request_review_comment`.
3. Test — GitHub's "Recent Deliveries" panel should show a 200.

## Check runs vs classic statuses

`getChecks` reads the **Check Runs** API only (the modern surface).
Classic statuses posted by older third-party CIs (e.g., CircleCI v1.x)
are not surfaced. Most modern CI providers post to both APIs, so this
is rarely an issue.

## Forward-compat: hosted app auth

Phase 5 ships only PAT auth. A hosted-app strategy (via the
`redqueen-github-app-server` repo) is planned — see
`prompts/github-app-server.md`. When available, only the `auth` block
changes:

```yaml
auth:
  type: hosted-app
  installationId: 12345
  tokenEndpoint: https://api.redqueen.sh/token
  userToken: ${REDQUEEN_ACCOUNT_TOKEN}
```

No adapter code will change.

## Known limitations (Phase 5)

- One owner/repo per Red Queen instance.
- Merge method is hardcoded to `squash`.
- Review dismissal uses a fixed message.
- Enterprise Server / self-hosted GitHub is not validated.
