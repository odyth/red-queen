# Contributing to Red Queen

Thanks for taking a look. Red Queen is a small, opinionated project —
it reaches full coverage without a huge codebase, which also means
changes need to respect the existing shape.

## Dev loop

```bash
git clone https://github.com/odyth/red-queen
cd red-queen
npm install
npm run check   # tsc + eslint + prettier — must pass
npm test        # Vitest
```

`npm run check` is the quality gate. CI runs the same command.

## Code style

- 2-space indent, double quotes, trailing commas, 100-char width.
- Prefer `=== false` over `!x`.
- Always `{}` braces.
- No new prod dependencies without discussion in an issue first.

## Commits & PRs

- Keep commits focused. A bug fix is one commit; a feature is one or
  more, each mergeable.
- PR titles describe the *why*. The body references the issue if there
  is one.
- We don't use `Co-Authored-By`.
- Every PR should include a `CHANGELOG.md` entry under `## [Unreleased]`
  unless the change is invisible to users (refactors, CI tweaks).

## Adding an adapter

Red Queen's integrations implement the `IssueTracker` or `SourceControl`
interfaces defined in
[`src/integrations/issue-tracker.ts`](src/integrations/issue-tracker.ts)
and
[`src/integrations/source-control.ts`](src/integrations/source-control.ts).

The three shipped adapters are the reference:

- [`src/integrations/jira/`](src/integrations/jira/) — most complex.
  Hand-rolled HTTP client, ADF converter, custom field mapping.
- [`src/integrations/github-issues/`](src/integrations/github-issues/) —
  label-based phase storage, marker comment for specs.
- [`src/integrations/github/`](src/integrations/github/) — source
  control via Octokit, pluggable auth strategies.

To add a new one (Linear, say):

1. Copy an existing adapter's directory as a template.
2. Implement the interface against the target tracker's API. Use
   `src/integrations/http/retry.ts` for rate limiting.
3. Add a Zod config schema and wire it into `src/cli/adapters.ts`'s
   `constructIssueTracker` / `constructSourceControl` switch.
4. Extend `src/core/config.ts`'s `issueTracker.type` enum to include
   your new value.
5. Write Layer 1 unit tests against a hand-rolled fetch mock.
6. Run your adapter through the shared
   `src/integrations/__tests__/issue-tracker-contract.ts` suite.
7. Write a `README.md` inside your adapter directory covering setup,
   env vars, and any known limitations.
8. Add your adapter to the comparison table and integration list in
   `README.md` and `CHANGELOG.md`.

## Release process

Normal releases (`v0.1.1` and onward) are cut by pushing a version tag:

```bash
npm version patch    # or minor / major
git push --follow-tags
```

The [`.github/workflows/release.yml`](.github/workflows/release.yml)
action picks it up, runs `npm run check` + `npm test`, and publishes to
npm via trusted publishing. Verify the GitHub Release draft and edit
the notes (sourced from `CHANGELOG.md`) before publishing.

### First-time publish is manual

npm trusted publishers can't be registered for an unclaimed package
name. The very first publish (`v0.1.0`) runs locally, then the workflow
takes over:

```bash
npm whoami                                # must resolve
npm run check && npm run test:ci && npm run build
npm publish --access public               # no --provenance; see note below
```

**Why no `--provenance` on the first publish:** provenance attestations
require an OIDC token that only supported CI environments (GitHub
Actions, GitLab, Buildkite, CircleCI) can produce. From a developer
laptop the flag errors out. v0.1.0 ships without provenance; the
workflow attaches it on every release from v0.1.1 onward. Acceptable
tradeoff for a preview release.

Then configure trusted publishing (below), then validate the workflow
with a throwaway pre-release (e.g. `v0.1.1-test.0`) and `npm unpublish`
it within 72h.

### One-time npm trusted publishing setup

After the first manual publish claims the package, set up trusted
publishing at
<https://www.npmjs.com/package/redqueen/access> > "Trusted Publishers" >
"Add". Configure:

- Publisher: GitHub Actions
- Organization or user: `odyth`
- Repository: `red-queen`
- Workflow filename: `release.yml`
- Environment: *(leave blank)*

No `NPM_TOKEN` secret is required after this. See
<https://docs.npmjs.com/trusted-publishers> for current docs.
