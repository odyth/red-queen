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

## Authentication: Bring-Your-Own GitHub App

### When to use it

Pick BYO App auth instead of a PAT when:

- You don't want bot activity showing up under a user's GitHub account.
- Your org forbids consuming a paid seat for automation.
- Your org prohibits service accounts — a private App is the sanctioned path.
- You want commits and comments to appear as `${app-slug}[bot]`.

Everything is self-hosted. You register the App in your own org, keep
the private key on your Red Queen host, and Red Queen signs JWTs locally
to mint installation tokens. No third-party token vendor, no shared server.

### Setup steps

1. **Register a private GitHub App in your org.** Settings → Developer
   settings → GitHub Apps → New GitHub App. Give it any name; set the
   homepage URL to anything (it's not used).
2. **Set permissions.** Repository permissions:
   - Contents: Read and write
   - Issues: Read and write
   - Pull requests: Read and write
   - Workflows: Read and write
   - Metadata: Read
3. **Disable webhooks in the App itself.** Uncheck "Active" under
   Webhook — Red Queen can poll, and webhooks via the App add complexity
   you probably don't want here.
4. **Generate and download a private key.** App settings → Private keys
   → Generate a private key. Save the `.pem` file to your host and lock
   it down:
   ```
   chmod 600 /etc/redqueen/myorg-app.pem
   ```
5. **Install the App on your repos.** App settings → Install App → pick
   the target org/account → choose "Only select repositories" and pick
   the ones Red Queen should manage. After install, the URL looks like:
   ```
   https://github.com/organizations/YOURORG/settings/installations/XXXXX
   ```
   The `XXXXX` is your **installation ID** — record it.
6. **Record the App ID** from the App's settings page (shown at the top,
   labeled "App ID").
7. **Configure `redqueen.yaml`** with the `byo-app` auth variant:

```yaml
sourceControl:
  type: github
  config:
    owner: myorg
    repo: myrepo
    auth:
      type: byo-app
      appId: ${GITHUB_APP_ID}
      installationId: ${GITHUB_APP_INSTALLATION_ID}
      privateKeyPath: ${GITHUB_APP_KEY_PATH}
```

And set the matching env vars in `.env`:

```
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=78910
GITHUB_APP_KEY_PATH=/etc/redqueen/myorg-app.pem
```

Relative paths resolve from the directory containing `redqueen.yaml`.

### Key format note

GitHub emits PKCS#1 PEMs (headers `-----BEGIN RSA PRIVATE KEY-----`).
Red Queen handles both PKCS#1 and PKCS#8 (`-----BEGIN PRIVATE KEY-----`)
— no conversion needed.

### Rotation

1. Generate a new key in the App settings.
2. Swap the `.pem` file on disk.
3. Restart Red Queen.

Old tokens stay valid for ~1 hour; new requests use the new key
immediately. Once you've confirmed the new key works, revoke the old
one in the App settings.

## Forward-compat: hosted app auth

A hosted-app strategy (via the `redqueen-github-app-server` repo) is
planned — see `prompts/github-app-server.md`. Unlike BYO App, the hosted
flavor is for users who don't want to run their own App. When available,
only the `auth` block changes:

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
