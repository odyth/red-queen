# Multi-Repo Workspaces — Plan 5 of 5: Dashboard and Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-09-13-multi-repo-workspace-design.md` §14 (Dashboard), §8 (webhook docs), docs in scope. **Prerequisites:** plans 1–4 merged. The header label (`sourceControlRepoLabel`) already branches on `workspaceMode` (plan 1 Task 4).

**Goal:** The dashboard's Status tab shows a per-issue PR list (every repo row with branch, PR, in-scope flag, orphaned marker) and the user-facing docs describe workspace mode end to end: config shape, `init`/`--add-repo`/`migrate`, per-repo webhooks, the skill contract, and the changelog entry.

**Architecture:** One new read-only endpoint `GET /api/pipelines` on `DashboardServer` (fed by an optional `pipelineState` dep the orchestrator wires), one new Status-tab section rendered by the existing client tab module, and shared wire types. No new dashboard features beyond the list. Docs edits are additive sections; the config reference stays "documented inline in `src/core/config.ts`".

**Tech Stack:** TypeScript (server + browser bundle via `npm run build:client`), vitest, Markdown.

## Global Constraints

- Config tab keeps rendering the raw YAML (that already shows `repos[]`); no editor for repos.
- Status and workflow views show a PR list per issue: repo, branch, PR number, in-scope flag; a descoped row with a PR is labelled `orphaned`.
- Header label: workspace root basename in workspace mode (done in plan 1).
- `src/dashboard/shared/api-types.ts` stays dependency-free (no Node imports).
- Docs: README gains a "Multi-repo workspaces" section; the GitHub adapter README says each repo needs its own webhook (or one org-level webhook) at the same URL with the shared secret; CHANGELOG "Unreleased/Added" gets the feature; `docs/index.html` FAQ line about monorepos gets a one-sentence pointer.
- Style rules from plan 1; `npm run check` after every change.

---

## File Structure

| File                                                                                | Responsibility                                                                |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/dashboard/shared/api-types.ts`                                                 | `PipelineRepoWire`, `PipelineWire`                                            |
| `src/dashboard/server.ts`                                                           | `DashboardDeps.pipelineState?`; `GET /api/pipelines`; `buildPipelinesPayload` |
| `src/dashboard/html/partials/status.ts`                                             | "Pipelines" section markup                                                    |
| `src/dashboard/client/api.ts`                                                       | `api.getPipelines()`                                                          |
| `src/dashboard/client/tabs/status.ts`                                               | `setPipelines(...)` rendering + fetch in `refresh()`                          |
| `src/core/orchestrator.ts`                                                          | Wires `pipelineState` into `DashboardServer`                                  |
| `README.md`, `src/integrations/github/README.md`, `CHANGELOG.md`, `docs/index.html` | Docs                                                                          |

---

### Task 1: `GET /api/pipelines` and the Status-tab PR list

**Files:**

- Modify: `src/dashboard/shared/api-types.ts`, `src/dashboard/server.ts:120-130` (`DashboardDeps`), route list (~line 377), `src/dashboard/html/partials/status.ts`, `src/dashboard/client/api.ts`, `src/dashboard/client/tabs/status.ts`, `src/core/orchestrator.ts:2029-2049` (`startDashboardIfEnabled`)
- Test: `src/dashboard/__tests__/server.test.ts`

**Interfaces:**

- Produces:

  ```ts
  // api-types.ts
  export interface PipelineRepoWire { repo: string; inScope: boolean; branchName: string | null; prNumber: number | null; orphaned: boolean }
  export interface PipelineWire { issueId: string; currentPhase: string | null; updatedAt: string; repos: PipelineRepoWire[] }
  // server.ts
  DashboardDeps.pipelineState?: Pick<PipelineStateStore, "listAll">;
  GET /api/pipelines → PipelineWire[]   // records with ≥1 row, newest first, max 50; [] when the dep is absent
  ```

- [ ] **Step 1: Write the failing test**

In `src/dashboard/__tests__/server.test.ts` (the file already builds a `DashboardServer` in `beforeEach` with `{ queue, orchestratorState, audit }` — add a second server-building helper or extend the existing deps with `pipelineState` for this test):

```ts
it("GET /api/pipelines lists repo rows per issue and flags orphaned PRs", async () => {
  const pipelineState = new PipelineStateStore(db, ["api", "web"]);
  pipelineState.create("PROJ-1", "human-review");
  pipelineState.setScope("PROJ-1", ["api", "web"]);
  pipelineState.updateBranchInfo("PROJ-1", "api", { branchName: "feature/PROJ-1", prNumber: 4 });
  pipelineState.updateBranchInfo("PROJ-1", "web", { branchName: "feature/PROJ-1", prNumber: 5 });
  pipelineState.setScope("PROJ-1", ["api"]);
  pipelineState.create("PROJ-2", "spec-writing"); // no rows → omitted

  await server.stop();
  port = await getFreePort();
  server = new DashboardServer(
    {
      queue: new SqliteTaskQueue(db),
      orchestratorState: new OrchestratorStateStore(db),
      audit,
      pipelineState,
    },
    { host: "127.0.0.1", port, enableDashboardUi: true, allowNonLoopback: false, allowedHosts: [] },
  );
  await server.start();

  const { status, body } = await fetchJson("/api/pipelines");
  expect(status).toBe(200);
  expect(body).toEqual([
    {
      issueId: "PROJ-1",
      currentPhase: "human-review",
      updatedAt: expect.any(String),
      repos: [
        { repo: "api", inScope: true, branchName: "feature/PROJ-1", prNumber: 4, orphaned: false },
        { repo: "web", inScope: false, branchName: "feature/PROJ-1", prNumber: 5, orphaned: true },
      ],
    },
  ]);
});

it("GET /api/pipelines returns [] without a pipelineState dep", async () => {
  const { status, body } = await fetchJson("/api/pipelines");
  expect(status).toBe(200);
  expect(body).toEqual([]);
});
```

(add `PipelineStateStore` to the `../../core/pipeline-state.js` import; `audit` is the file's `DualWriteAuditLogger` instance — check the `beforeEach` for its variable name.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard/__tests__/server.test.ts -t pipelines`
Expected: FAIL — 404.

- [ ] **Step 3: Implement**

`src/dashboard/shared/api-types.ts` — after the `StatusPayload` block:

```ts
// --- Pipelines (per-issue repo rows) ---

export interface PipelineRepoWire {
  repo: string;
  inScope: boolean;
  branchName: string | null;
  prNumber: number | null;
  // Descoped by a later spec revision but still holding a PR — a human closes it.
  orphaned: boolean;
}

export interface PipelineWire {
  issueId: string;
  currentPhase: string | null;
  updatedAt: string;
  repos: PipelineRepoWire[];
}
```

`src/dashboard/server.ts`:

```ts
import type { PipelineStateStore } from "../core/pipeline-state.js";
import type { PipelineWire, ... } from "./shared/api-types.js";

export interface DashboardDeps {
  queue: TaskQueue;
  orchestratorState: OrchestratorStateStore;
  audit: AuditLogger;
  // Optional so tests and legacy call sites need not wire it; the pipelines
  // list renders empty without it.
  pipelineState?: Pick<PipelineStateStore, "listAll">;
  service?: DashboardServiceDeps;
  editor?: DashboardEditorDeps;
  cost?: DashboardCostDeps;
}
```

Route (next to `/api/queue`):

```ts
routes.push({
  method: "GET",
  path: "/api/pipelines",
  handler: (_req, res) => {
    this.sendJson(res, 200, this.buildPipelinesPayload());
  },
});
```

Builder (next to `buildQueuePayload`):

```ts
  private buildPipelinesPayload(): PipelineWire[] {
    const store = this.deps.pipelineState;
    if (store === undefined) {
      return [];
    }
    return store
      .listAll()
      .filter((record) => record.repos.length > 0)
      .slice(0, 50)
      .map((record) => ({
        issueId: record.issueId,
        currentPhase: record.currentPhase,
        updatedAt: record.updatedAt,
        repos: record.repos.map((row) => ({
          repo: row.repo,
          inScope: row.inScope,
          branchName: row.branchName,
          prNumber: row.prNumber,
          orphaned: row.inScope === false && row.prNumber !== null,
        })),
      }));
  }
```

`src/dashboard/html/partials/status.ts` — insert before the "Recent Log" section:

```ts
  <section class="span2">
    <h2>Pipelines (PRs per issue)</h2>
    <ul id="pipelines"><li class="empty">(none)</li></ul>
  </section>
```

`src/dashboard/client/api.ts`: add `getPipelines: () => getJson<PipelineWire[]>("/api/pipelines"),` (import the type).

`src/dashboard/client/tabs/status.ts`:

```ts
import type { PipelineWire } from "../../shared/api-types.js";

function setPipelines(items: PipelineWire[] | null): void {
  const el = qs("#pipelines");
  if (el === null) {
    return;
  }
  if (items === null || items.length === 0) {
    el.innerHTML = '<li class="empty">(none)</li>';
    return;
  }
  el.innerHTML = items
    .map((p) => {
      const rows = p.repos
        .map((r) => {
          const pr = r.prNumber === null ? "—" : `PR #${String(r.prNumber)}`;
          const flag = r.orphaned
            ? ' <span class="err">orphaned</span>'
            : r.inScope === false
              ? ' <span class="muted">(descoped)</span>'
              : "";
          return `<li>${escapeHtml(r.repo)} · ${escapeHtml(r.branchName ?? "—")} · ${pr}${flag}</li>`;
        })
        .join("");
      return `<li><strong>${escapeHtml(p.issueId)}</strong> <span class="muted">${escapeHtml(p.currentPhase ?? "—")}</span><ul>${rows}</ul></li>`;
    })
    .join("");
}
```

and in `refresh()` fetch it alongside the others:

```ts
const [status, queue, logs, pipelines] = await Promise.all([
  api.getStatus(),
  api.getQueue(),
  api.getLogs(),
  api.getPipelines(),
]);
// …
setPipelines(pipelines);
```

`src/core/orchestrator.ts` `startDashboardIfEnabled`: add `pipelineState: this.deps.pipelineState,` to the `DashboardServer` deps object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dashboard`
Expected: PASS. Then `npm run build` to confirm the client bundle compiles (`tsc -p tsconfig.client.json` runs inside `npm run check` too).

- [ ] **Step 5: Check + commit**

```bash
npm run check
git add src/dashboard src/core/orchestrator.ts
git commit -m "feat(dashboard): list every repo row per issue on the status tab"
```

---

### Task 2: Docs

**Files:**

- Modify: `README.md` (after "### Stacked branches", before "## Verification checklist"), `src/integrations/github/README.md` (Configuration + a new "Webhooks per repo" subsection), `CHANGELOG.md` (`[Unreleased]` → `Added`), `docs/index.html` (the monorepo FAQ answer, ~line 884)

- [ ] **Step 1: README section**

Insert after the "Stacked branches" section:

````markdown
### Multi-repo workspaces

One instance can drive several repos. Install Red Queen in a **workspace
root** — a folder that contains your repos — and declare them under
`project.repos[]`:

```yaml
project:
  directory: .
  repos:
    - name: api # ^[a-z0-9][a-z0-9-]*$ — used in paths and --repo flags
      path: ./Api # relative to project.directory, or absolute
      owner: acme
      repo: Api
      baseBranch: origin/master # optional; defaults to pipeline.baseBranch
      buildCommand: dotnet build
      testCommand: dotnet test
      modules: # optional; same shape as before, paths repo-relative
        - name: portal
          paths: ["src/Portal/**"]
          buildCommand: dotnet build src/Portal
          testCommandTargeted: dotnet test src/Portal.Tests
    - name: email-templates
      path: ./EmailTemplates
      owner: acme
      repo: EmailTemplates
      buildCommand: npm run build
      testCommand: npm test
```
````

The `project.repos` key switches the install into workspace mode. There
`project.buildCommand` / `testCommand` / `modules` and
`sourceControl.config.owner` / `repo` are rejected — they live per repo — while
`sourceControl.config.auth` (and `webhookSecret`) stays shared. With GitHub App
auth every repo must have the same owner (an installation token is scoped to
one owner); token auth allows any mix. A `github-issues` tracker keeps its own
`owner/repo`, which need not be in `repos[]`.

Getting there:

- Fresh: `cd` to the parent folder of your clones and run `redqueen init` —
  it discovers the git children, derives `owner/repo` from `origin`, and
  writes `repos[]`.
- Existing single-repo install: `redqueen migrate` moves the install up one
  directory (config, `.env`, database, and in-flight worktrees, which stay
  registered) and lifts today's fields into `repos[0]`. Then
  `redqueen init --add-repo <path>` for each sibling. `--dry-run` shows the
  plan first.
- Convert in place without moving: `redqueen init --add-repo <path>` on a
  legacy install lifts it to workspace mode with the current repo at `path: .`.

How a ticket flows: the prompt-writer reads the workspace map plus each
candidate repo's `CLAUDE.md` / `AGENTS.md`, explores a throwaway worktree per
repo, and records which repos are in scope with `redqueen spec meta --repos`.
Every downstream skill loops over those repos: one branch and one PR per repo
(worktrees live at `.redqueen/worktrees/<issue>/<repo>`), one review per PR,
tests per repo. The ticket is done when **every** in-scope PR has merged;
merge order across repos is yours. A repo dropped from scope by a later spec
revision keeps its PR — `redqueen status` and the dashboard mark it
`orphaned` for you to close.

Webhooks: each repo needs its own source-control webhook (or one org-level
webhook) pointing at the same URL with the same secret.

Single-repo installs are unchanged: no `repos[]`, same config, same prompts.

````

- [ ] **Step 2: GitHub adapter README**

After the "## Configuration" block add:

```markdown
### Workspace mode

With `project.repos[]` in `redqueen.yaml`, `sourceControl.config` carries only
`auth` and `webhookSecret`; `owner`/`repo` come from each `repos[]` entry and
one adapter is built per repo, all sharing the same auth strategy.

### Webhooks per repo

The receiver validates every delivery with the shared `webhookSecret` and
routes `pull_request` / review / comment events by the payload's
`repository.full_name`. Add a webhook on **every** repo in `repos[]` (or a
single org-level webhook) pointing at the same URL — deliveries from a repo
that is not configured are logged and dropped.
````

- [ ] **Step 3: CHANGELOG**

Under `## [Unreleased]` → `### Added`, prepend:

```markdown
- Multi-repo workspaces: one instance can drive several repos declared under
  `project.repos[]`. The prompt-writer decides which repos a ticket touches
  (`redqueen spec meta --repos`), the coder opens one PR per repo, and the
  ticket completes only after every in-scope PR merges. `redqueen init` in a
  folder of git repos scaffolds a workspace, `redqueen init --add-repo <path>`
  appends a repo, and `redqueen migrate` moves an existing single-repo install
  up one directory. Single-repo installs are unchanged. Also fixed: the
  codebase map generated by `init` is now passed to every skill
  (`codebaseMapPath` was never wired).
```

- [ ] **Step 4: docs/index.html FAQ**

Extend the monorepo answer (the `<p>` after `<summary>Does it work with monorepos?</summary>`) with one sentence:

```html
For several repos per product, declare them under <code>project.repos[]</code> — one instance, one
PR per repo per ticket; see “Multi-repo workspaces” in the README.
```

- [ ] **Step 5: Verify + commit**

```bash
npm run check
npx prettier --check README.md CHANGELOG.md src/integrations/github/README.md || npx prettier --write README.md CHANGELOG.md src/integrations/github/README.md
git add README.md CHANGELOG.md src/integrations/github/README.md docs/index.html
git commit -m "docs: multi-repo workspaces — config, init/migrate, per-repo webhooks"
git push
```

---

## Plan-level verification

- [ ] `npm run check` and `npx vitest run` clean; `npm run build` produces the client bundle.
- [ ] Manual: start a workspace install with the dashboard on, open the Status tab — the header shows the workspace root's basename, and "Pipelines" lists each ticket's repo rows with `orphaned` where a descoped row still holds a PR.
- [ ] Read README's new section once against a real `redqueen.yaml` from plan 4's `init` to confirm the example parses (`redqueen status`).

## Self-review notes

- §14: header label (plan 1), Status/workflow PR list (Task 1 — a single Status-tab section is the "workflow view" equivalent; the Workflow tab is the phase-graph editor and gets no per-issue state), Config tab unchanged (raw YAML shows `repos[]`). §8 webhook docs (Task 2 GitHub README). Spec §1 config shape, §11–§13 commands, §9 flow, and decision 6/10 semantics are all summarized in the README section. CHANGELOG covers the `codebaseMapPath` side finding.
