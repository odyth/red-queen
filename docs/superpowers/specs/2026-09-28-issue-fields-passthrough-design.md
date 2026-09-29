# Issue Description and Custom-Field Passthrough

**Date:** 2026-09-28
**Status:** Approved design, pending implementation
**Scope:** `src/integrations/issue-tracker.ts`, `src/integrations/jira/adapter.ts`, `src/integrations/jira/README.md`, `src/integrations/github-issues/adapter.ts`, `src/core/config.ts`, `src/core/types.ts`, `src/core/skill-context.ts`, `src/core/orchestrator.ts`, `src/core/__tests__/fixtures/mock-adapters.ts`, `src/skills/prompt-writer/SKILL.md`, `src/skills/prompt-writer-workspace/SKILL.md`, `README.md`, tests.

## Problem

`redqueen issue get` is the only way a skill reads the ticket. The
`Issue` type it returns has eleven fields: id, key, summary, status, phase,
assignee, reporter, issueType, labels, createdAt, updatedAt. Two things
the reporter wrote never reach the prompt writer:

- **The ticket description.** `JiraIssueTrackerAdapter.toIssue` never maps
  `fields.description`; the GitHub Issues adapter never maps `body`. The
  prompt-writer skills say "description (if present in the adapter's JSON)",
  and it is never present. Verified by running the adapter against a raw
  issue carrying an ADF description: the output has no description key.
  This has been true since the phase 2 commit; it is not a regression.
- **Custom fields that classify the ticket.** AlignSmart's Jira has a
  `Product` select (`customfield_10039`) whose value (`App`, `Web`, ...)
  tells a human which repository the work lands in. The multi-repo
  workspace prompt writer has to pick repos in scope with no access to it.

Installs where the worker's Claude environment happens to have Jira MCP
access have been reading the description around Red Queen. That is an
undeclared dependency on the agent's environment and does not hold for
other installs.

## Goals

1. `issue get` returns the ticket description for every built-in adapter.
2. An install can name Jira custom fields to pass through, by a
   tracker-agnostic name, without code changes.
3. An install can declare which passthrough values point at which repo, and
   the workspace prompt writer receives that as a per-repo suggestion.
4. Nothing product-specific (no "Product", no "App") appears in Red Queen
   source or shipped skills.
5. Single-repo installs and installs that configure nothing see no change in
   the skill prompt apart from the new `description` and `fields` keys in
   `issue get` output.

## Decisions (made during design)

- **Display values only.** Passthrough fields flatten to a string. Jira
  option ids are not surfaced; nothing downstream reads or writes them.
- **Matching is computed in the orchestrator, not by the LLM.** The
  orchestrator already fetches the issue before building the skill context
  (`orchestrator.ts`, the `getIssue` call that resolves `issueType`). It
  compares `issue.fields` with `repos[].fields` and emits a boolean. The
  skill is told the result, not asked to derive it. This keeps the mapping a
  config fact and the decision auditable.
- **Suggestion, not scope.** A matching repo becomes the default candidate
  for the prompt writer. The prompt writer still decides scope and records
  it with `redqueen spec meta --repos`; suggestions never write
  `inScope`.
- **Fetch failure keeps today's behavior.** If `getIssue` fails while
  building the context (already caught and audited for `issueType`), every
  repo gets `suggested: false`.
- **Out of scope:** `jira discover` enumerating select fields; mapping
  GitHub labels into `fields`; `redqueen init --add-repo` support for
  `repos[].fields`. All are follow-ups.

## Design

### 1. `Issue` gains two fields

`src/integrations/issue-tracker.ts`:

```ts
export interface Issue {
  // ...existing eleven fields...
  // Ticket body as markdown; null when the tracker has none.
  description: string | null;
  // Install-named passthrough values (see Jira customFields.extra).
  // Always present; empty for trackers that expose nothing.
  fields: Record<string, string | null>;
}
```

Both are required on the type so every adapter and fixture is forced to
populate them. `redqueen issue get` needs no change: it already serializes
the whole `Issue`.

### 2. Jira adapter

**Config** (`JiraConfigSchema.customFields`):

```ts
customFields: z.object({
  phase: z.string().min(1),
  spec: z.string().min(1),
  extra: z.record(z.string().min(1), z.string().min(1)).default({}),
}),
```

Key is the tracker-agnostic name a skill will see (`product`); value is
the Jira field id (`customfield_10039`). Example in `README.md` and
`src/integrations/jira/README.md`:

```yaml
customFields:
  phase: customfield_10158
  spec: customfield_10157
  extra:
    product: customfield_10039
```

**Fetch.** `searchIssues` adds `"description"` and every
`Object.values(customFields.extra)` to its `fields=` list. `getIssue`
already fetches all fields and needs no change.

**Map.** `toIssue` adds:

- `description`: `fields.description` is `null`/`undefined` → `null`;
  string → as-is; otherwise `fromAdf(value as AdfNode)`.
- `fields`: for each `[name, fieldId]` in `customFields.extra`,
  `fields[name] = flattenJiraField(raw.fields[fieldId])`.

`flattenJiraField(value: unknown): string | null`, private to the adapter:

| Raw value | Result |
|---|---|
| `null` / `undefined` | `null` |
| `string` | as-is |
| `number` | `String(value)` |
| object with string `value` (select option) | `.value` |
| object with string `name` (user, version, component, option without value) | `.name` |
| array | each element flattened, nulls dropped, joined with `", "`; empty → `null` |
| anything else | `null` |

No throw on unknown shapes: a misconfigured field id produces `null`, which
the skill treats as "not set".

### 3. GitHub Issues and mock adapters

- `github-issues/adapter.ts` `toIssue`: `description: raw.body ?? null`,
  `fields: {}`. `IssueRaw` gains `body?: string | null`.
- `src/core/__tests__/fixtures/mock-adapters.ts` `makeIssue`:
  `description: null`, `fields: {}`.
- `src/__tests__/issue-tracker-contract.ts`: the `getIssue` contract
  asserts both keys are present (`description` is `string | null`,
  `fields` is an object).

### 4. Repo config

`src/core/config.ts` `RepoSchema`:

```ts
fields: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).default({}),
```

Legacy (non-workspace) mode synthesizes `fields: {}` for its single repo.
Validation: none beyond the schema. A field name that no tracker supplies
simply never matches. Example:

```yaml
project:
  repos:
    - name: app
      path: ./app
      owner: alignsmart
      repo: App
      fields:
        product: [App]
    - name: alignsmart
      path: ./alignsmart
      owner: alignsmart
      repo: AlignSmart
      fields:
        product: [Web, API]
```

### 5. Skill context

`src/core/types.ts` `SkillContextRepo` gains:

```ts
// Workspace mode: true when any configured repos[].fields value equals the
// issue's passthrough value for that field. Never affects inScope.
suggested: boolean;
```

`src/core/skill-context.ts` `SkillContextDeps` gains
`issueFields?: Record<string, string | null>`. In the `repoEntries` map:

```ts
suggested: isSuggested(repo.fields, deps.issueFields ?? {}),
```

```ts
function isSuggested(
  repoFields: Record<string, string[]>,
  issueFields: Record<string, string | null>,
): boolean {
  return Object.entries(repoFields).some(([name, wanted]) => {
    const actual = issueFields[name];
    return actual !== null && actual !== undefined && wanted.includes(actual);
  });
}
```

Comparison is exact-string. Multi-select values arrive joined with
`", "` and will not match a single wanted value; that is acceptable for
this iteration and documented in the README.

`src/core/orchestrator.ts`: the existing block that resolves `issueType`
keeps the `Issue` it fetched and passes `issueFields: issue.fields` into
`buildSkillContext`. On the existing catch path, `issueFields` is omitted.

`suggested` is emitted only inside `repos[]`, which is only present in
workspace mode, so single-repo prompts stay byte-identical.

### 6. Skills

Both `src/skills/prompt-writer/SKILL.md` and
`src/skills/prompt-writer-workspace/SKILL.md`, "Step 1: Read the issue"
(fresh write): replace

> Look at `summary`, description (if present in the adapter's JSON), and
> any prior comments

with

> Look at `summary`, `description` (the ticket body as markdown, `null`
> when the reporter left it empty), `fields` (install-defined ticket
> attributes such as a product or component; may be empty), and any prior
> comments

`prompt-writer-workspace/SKILL.md` only:

- Context-block reference for `repos`: add `suggested` to the listed keys
  and this sentence: "`suggested: true` means the install's config maps one
  of this issue's `fields` values to this repo."
- Candidate-repo step (currently step 5 of the pre-flight): replace the
  "start generously" paragraph with:

  > Identify the candidate repos. If any repo has `suggested: true`, start
  > with exactly those and add another repo only when the change cannot be
  > completed without it (say why in the spec's Repos in Scope section).
  > If no repo is suggested, use the workspace map and ticket context and
  > start generously; if that is insufficient, start with all repos.

No product names, field names, or repo names appear in either skill.

### 7. Docs

- `README.md` and `src/integrations/jira/README.md`: `customFields.extra`
  example, `repos[].fields` example, one paragraph on suggestion semantics
  (exact match, multi-select caveat, suggestion is not scope).

## Error handling

- Unknown or mistyped Jira field id in `extra`: Jira ignores unknown ids in
  `fields=`, the value is absent, the passthrough is `null`. No error.
- Unrecognised field shape: `null`, never a throw (see flatten table).
- ADF description that `fromAdf` cannot render: `fromAdf` already handles
  unknown nodes by dropping them; the result may be partial but never
  throws.
- `getIssue` failure while building context: already audited; repos get
  `suggested: false`.

## Testing

- `jira/__tests__/adapter.test.ts`: `getIssue` maps an ADF description to
  markdown, a string description as-is, and a missing one to `null`;
  `extra` passthrough for select option, string, number, user object,
  multi-select array, missing field, and unknown shape; `searchIssues`
  requests `description` and every extra field id.
- `github-issues/__tests__`: `body` → `description`, `fields` is `{}`.
- `src/__tests__/issue-tracker-contract.ts`: both keys present.
- `core/__tests__/config.test.ts`: `repos[].fields` parses, defaults to
  `{}`, rejects an empty array value; legacy mode synthesizes `{}`.
- `core/__tests__/skill-context.test.ts`: `suggested` true on exact match,
  false on case mismatch, false when the issue field is `null`, false when
  `issueFields` is omitted, false when the repo has no `fields`; non-workspace
  context output unchanged.
- Orchestrator test: `buildSkillContext` receives `issueFields` from the
  fetched issue and omits it when `getIssue` throws.
- `npm run check` clean.

## Non-goals (follow-ups, not in this spec)

- `redqueen jira discover` listing candidate select fields for `extra`.
- GitHub Issues: mapping labels or a label prefix into `fields`.
- `redqueen init --add-repo` prompting for `repos[].fields`.
- Fuzzy or case-insensitive matching; matching individual multi-select
  values.
- Surfacing `description` or `fields` to non-spec-writing skills. They
  can already call `issue get`.

## Suggested implementation order

1. `Issue` type + mock adapter + contract test (compile errors guide the
   rest).
2. Jira adapter: config, fetch, `flattenJiraField`, `toIssue`, tests.
3. GitHub Issues adapter + tests.
4. `RepoSchema.fields` + legacy synthesis + config tests.
5. `SkillContextRepo.suggested`, `isSuggested`, orchestrator plumbing,
   tests.
6. Skill markdown edits (both prompt writers).
7. READMEs.
