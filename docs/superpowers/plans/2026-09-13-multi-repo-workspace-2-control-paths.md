# Multi-Repo Workspaces — Plan 2 of 5: Per-Repo Control Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-09-13-multi-repo-workspace-design.md` §3 (rework/stack/dismiss rows), §4 (worktree layout), §7 (CLI helpers), §8 (webhooks, reconciler, merge cleanup). **Prerequisite:** plan 1 (`2026-09-13-multi-repo-workspace-1-foundation.md`) is merged — `config.project.repos`, `PipelineRecord.repos`, `PipelineStateStore` per-row API, `SourceControlRegistry`, `SkillContextDeps.repoPrBases`, and `--repo` on `pr`/`pipeline update` all exist.

**Goal:** Every control decision reads `pipeline_repos` rows and acts per repo: the rework gate, the stack blocker gate, webhook routing by `owner/repo`, merge processing that marks the issue done only after the last in-scope PR merges, merge cleanup and stack refresh rooted at each repo's own path, the reconciler skip, `spec meta --repos`, `stack setup` per repo, and `redqueen status` listing rows.

**Architecture:** A small `worktree-layout` module owns the two layouts (nested per repo in workspace mode, flat in legacy mode) and the git cwd rule ("never run git at the workspace root"). `resolveStack` classifies each blocker per repo and returns `repos: Record<name, {mergeBranches, prBase}>`; the ticket-level gate is unsatisfied while any in-scope row of any blocker lacks a PR. The webhook server resolves the acting row from the event's `repo` full name (or the row name on poll-sourced events) and calls the per-row store methods; `"processed"` means the issue just completed, `"pending-others"` means only the row did.

**Tech Stack:** TypeScript 5 (`strict`), better-sqlite3, vitest, node `child_process` for git.

## Global Constraints

- Every git invocation takes its cwd from the acting row's `repo.path`; nothing runs git at the workspace root. This covers `worktree add/remove`, `branch -D`, `fetch`, `ls-remote`, `push`, `merge`.
- Worktree layout — workspace mode: `<root>/.redqueen/worktrees/<issueId>/<repoName>` (coding), `<root>/.redqueen/worktrees/spec-<issueId>/<repoName>` (spec), `<root>/.redqueen/worktrees/refresh-<issueId>/<repoName>` (refresh). Legacy mode keeps `<projectDir>/.redqueen/worktrees/<issueId>` (and `spec-`/`refresh-` prefixes) unchanged.
- Blocker gate per repo: for repo R a blocker is _satisfied_ when its R row has a branch and its tracker phase is a terminal gate; _not applicable_ when it has no R row; _unsatisfied_ otherwise. The ticket-level gate is unsatisfied while any in-scope row of any blocker lacks a PR. Merge branches and PR bases are per repo.
- `rework-transition`: `hasPr` is true when any in-scope row has a PR.
- Done = all in-scope PRs merged. A merge for a descoped row runs the row transition and local cleanup but never advances the issue. Reconciler skip keys on every in-scope row having `prNumber === null`; descoped rows ignored.
- Unknown `--repo`, unknown webhook full name, or a `spec meta --repos` name not in config: hard error (or audited drop for webhooks) listing valid names.
- `spec meta --repos` required in workspace mode, at least one name, all in config; legacy ignores it.
- `stack setup` loops in-scope repos (all repos with `--spec`); per repo it merges only ancestor branches that exist for that repo (rows in that repo); exit codes unchanged (2 = conflict, 3 = blocked, 1 = error); JSON lists per-repo results and the conflicting repo on exit 2.
- `status` lists every repo row per issue; a descoped row with a PR is labelled `orphaned`.
- Style rules from plan 1 (no `!` except `!=`/`!==`, braces always, `=== false`, `npm run check` after every change, no `Co-Authored-By`).

---

## File Structure

| File                                  | Responsibility after this plan                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/core/worktree-layout.ts` (new)   | `worktreePathFor`, `repoConfigOf`, `gitCwdFor`                                                        |
| `src/core/rework-transition.ts`       | `hasPr` over in-scope rows                                                                            |
| `src/core/stack.ts`                   | Per-repo classification; `StackResolution.repos`; `StackResolveDeps.repos`                            |
| `src/core/orchestrator.ts`            | Passes repos to `resolveStack`; `repoPrBases` into the skill context                                  |
| `src/integrations/github/webhook.ts`  | `repo: payload.repository.full_name` on `pr-merged` / `pr-feedback`                                   |
| `src/webhook/server.ts`               | Row resolution by full name; per-row merge, cleanup, retarget, refresh, scan; pending cleanup per row |
| `src/core/reconciler.ts`              | Skip rule over in-scope rows                                                                          |
| `src/cli/spec.ts`                     | `spec meta --repos`                                                                                   |
| `src/cli/stack.ts`                    | Per-repo assembly, per-repo JSON                                                                      |
| `src/cli/pr.ts`                       | `pr create` per-repo stacked base                                                                     |
| `src/cli/pipeline.ts`                 | `pipeline cleanup` per row, git at each repo path                                                     |
| `src/cli/status.ts`                   | Pipelines section with repo rows and `orphaned`                                                       |
| `src/cli/help.ts`                     | Flag docs                                                                                             |
| `src/__tests__/e2e/full-loop.test.ts` | Two-repo workspace loop                                                                               |

---

### Task 1: Rework gate reads in-scope rows

**Files:**

- Modify: `src/core/rework-transition.ts:40-50`
- Modify: `src/webhook/server.ts:242-243` (`pr-feedback` `hasPr`)
- Test: `src/core/__tests__/rework-transition.test.ts` (new)

**Interfaces:**

- Consumes: `PipelineRecord.repos` (plan 1).
- Produces: no signature change. `ReworkTransitionContext.pipelineState` stays `Pick<PipelineStateStore, "get" | "updatePhase">`.

- [ ] **Step 1: Write the failing test**

Create `src/core/__tests__/rework-transition.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../database.js";
import { PipelineStateStore } from "../pipeline-state.js";
import { autoTransitionRework } from "../rework-transition.js";
import { buildPhaseGraph } from "../config.js";
import { DEFAULT_PHASES } from "../defaults.js";
import type { AuditLogger } from "../audit.js";
import { MockIssueTracker } from "./fixtures/mock-adapters.js";

const silentAudit: AuditLogger = {
  log: () => undefined,
  query: () => [],
  prune: () => 0,
};

function harness(): { store: PipelineStateStore; tracker: MockIssueTracker } {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  return { store: new PipelineStateStore(db, ["api", "web"]), tracker: new MockIssueTracker() };
}

describe("autoTransitionRework hasPr over in-scope rows", () => {
  const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);

  it("treats a PR on any in-scope row as hasPr (code-feedback requiresPr: true)", async () => {
    const { store, tracker } = harness();
    store.create("PROJ-1", "human-review");
    store.setScope("PROJ-1", ["api", "web"]);
    store.updatePrNumber("PROJ-1", "web", 5, "main");
    const result = await autoTransitionRework(
      { issueTracker: tracker, pipelineState: store, phaseGraph, audit: silentAudit },
      "PROJ-1",
      "human-review",
      "code-feedback",
      "test",
      {},
    );
    expect(result).toBe("transitioned");
  });

  it("ignores a PR on a descoped row", async () => {
    const { store, tracker } = harness();
    store.create("PROJ-1", "human-review");
    store.setScope("PROJ-1", ["api", "web"]);
    store.updatePrNumber("PROJ-1", "web", 5, "main");
    store.setScope("PROJ-1", ["api"]);
    const result = await autoTransitionRework(
      { issueTracker: tracker, pipelineState: store, phaseGraph, audit: silentAudit },
      "PROJ-1",
      "human-review",
      "code-feedback",
      "test",
      {},
    );
    expect(result).toBe("skip");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/__tests__/rework-transition.test.ts`
Expected: the first test passes by accident only if the mirror happens to hold `web`'s PR; the second FAILS (`transitioned` instead of `skip`) because the mirror still reports a PR from the first in-scope row after descoping? — no: after descoping `web`, the mirror points at `api` (no PR) so the second passes and the first fails once `api` (no PR) is first in scope. Either way at least one assertion fails; confirm before implementing.

- [ ] **Step 3: Implement**

`src/core/rework-transition.ts`, replace lines 42–43:

```ts
const record = ctx.pipelineState.get(issueId);
const hasPr = record !== null && record.repos.some((row) => row.inScope && row.prNumber !== null);
```

`src/webhook/server.ts` `pr-feedback` case, replace `const hasPr = record !== null && record.prNumber !== null;` with:

```ts
const hasPr = record !== null && record.repos.some((row) => row.inScope && row.prNumber !== null);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/__tests__/rework-transition.test.ts src/webhook/__tests__/server.test.ts src/core/__tests__/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Check + commit**

```bash
npm run check
git add src/core/rework-transition.ts src/webhook/server.ts src/core/__tests__/rework-transition.test.ts
git commit -m "feat(rework): gate on any in-scope repo PR instead of the scalar mirror"
```

---

### Task 2: Stack blocker gate per repo

**Files:**

- Modify: `src/core/stack.ts`
- Modify: `src/core/orchestrator.ts:481-552` (`guardStackBlockers`), `:1221-1229` (`buildSkillContext` call)
- Modify: `src/cli/pr.ts` (`cmdPrCreate` base recompute)
- Test: `src/core/__tests__/stack.test.ts`, `src/core/__tests__/orchestrator-stack.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export interface StackRepoTarget {
    name: string;
    bareBase: string;
  }
  export interface StackRepoResolution {
    mergeBranches: string[];
    prBase: string;
  }
  export interface StackResolveDeps {
    getBlockedBy;
    getPipelineRecord;
    getTrackerPhase;
    terminalGates;
    // Repos to assemble per-repo results for. Omitted → [{ name: DEFAULT_REPO_NAME, bareBase }].
    repos?: readonly StackRepoTarget[];
  }
  export interface StackResolution {
    ok;
    directBlockers;
    mergeBranches;
    prBase;
    unsatisfied;
    cycle;
    problems;
    repos: Record<string, StackRepoResolution>; // top-level mergeBranches/prBase mirror repos[<first target>]
  }
  // resolveStack(issueId, bareBase, deps) — signature unchanged
  ```
- `StackProblem.kind: "missing-branch"` detail names the repos lacking a branch.
- Consumes: `PipelineRecord.repos`, `DEFAULT_REPO_NAME`, `SkillContextDeps.repoPrBases`.

- [ ] **Step 1: Write the failing tests**

In `src/core/__tests__/stack.test.ts`, replace the `record()` helper so scalar overrides also produce a row (rows are what the gate reads now):

```ts
import type { PipelineRecord, PipelineRepoRecord } from "../types.js";

function record(
  issueId: string,
  overrides: Partial<PipelineRecord> = {},
  rows?: PipelineRepoRecord[],
): PipelineRecord {
  const base: Omit<PipelineRecord, "repos"> = {
    issueId,
    currentPhase: "coding",
    priorPhase: null,
    branchName: null,
    prNumber: null,
    prBaseBranch: null,
    terminalPrNumber: null,
    worktreePath: null,
    reviewIterations: 0,
    feedbackIterations: 0,
    specContent: null,
    priorContext: null,
    delegatorAccountId: null,
    openQuestionCount: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  const derived: PipelineRepoRecord[] =
    base.branchName !== null || base.prNumber !== null
      ? [row(issueId, "default", { branchName: base.branchName, prNumber: base.prNumber })]
      : [];
  return { ...base, repos: rows ?? derived };
}

function row(
  issueId: string,
  repo: string,
  overrides: Partial<PipelineRepoRecord> = {},
): PipelineRepoRecord {
  return {
    issueId,
    repo,
    inScope: true,
    branchName: null,
    prNumber: null,
    prBaseBranch: null,
    terminalPrNumber: null,
    worktreePath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
```

Then append:

```ts
describe("resolveStack per repo", () => {
  const targets = [
    { name: "api", bareBase: "main" },
    { name: "web", bareBase: "develop" },
  ];

  it("merges a blocker's branch only in the repos it touched and bases the PR per repo", async () => {
    const h = mkDeps();
    h.deps.repos = targets;
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.records.set(
      "#1",
      record("#1", { currentPhase: "human-review" }, [
        row("#1", "api", { branchName: "feature/#1", prNumber: 10 }),
      ]),
    );
    h.phases.set("#1", "human-review");

    const r = await resolveStack("#2", "main", h.deps);

    expect(r.ok).toBe(true);
    expect(r.repos).toEqual({
      api: { mergeBranches: ["feature/#1"], prBase: "feature/#1" },
      web: { mergeBranches: [], prBase: "develop" },
    });
    // Top-level fields mirror the first target.
    expect(r.mergeBranches).toEqual(["feature/#1"]);
    expect(r.prBase).toBe("feature/#1");
  });

  it("is unsatisfied while any in-scope row of a blocker lacks a PR", async () => {
    const h = mkDeps();
    h.deps.repos = targets;
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.records.set(
      "#1",
      record("#1", { currentPhase: "human-review" }, [
        row("#1", "api", { branchName: "feature/#1", prNumber: 10 }),
        row("#1", "web", { branchName: "feature/#1", prNumber: null }),
      ]),
    );
    h.phases.set("#1", "human-review");

    const r = await resolveStack("#2", "main", h.deps);

    expect(r.ok).toBe(false);
    expect(r.unsatisfied).toEqual(["#1"]);
    expect(h.phaseCalls).toEqual([]);
  });

  it("ignores descoped rows of a blocker", async () => {
    const h = mkDeps();
    h.deps.repos = targets;
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.records.set(
      "#1",
      record("#1", { currentPhase: "human-review" }, [
        row("#1", "api", { branchName: "feature/#1", prNumber: 10 }),
        row("#1", "web", { inScope: false, branchName: "feature/#1", prNumber: null }),
      ]),
    );
    h.phases.set("#1", "human-review");

    const r = await resolveStack("#2", "main", h.deps);

    expect(r.ok).toBe(true);
    expect(r.repos.web).toEqual({ mergeBranches: [], prBase: "develop" });
  });

  it("reports the repos missing a branch at the gate", async () => {
    const h = mkDeps();
    h.deps.repos = targets;
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.records.set(
      "#1",
      record("#1", { currentPhase: "human-review" }, [
        row("#1", "api", { branchName: "feature/#1", prNumber: 10 }),
        row("#1", "web", { branchName: null, prNumber: 11 }),
      ]),
    );
    h.phases.set("#1", "human-review");

    const r = await resolveStack("#2", "main", h.deps);

    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      expect.objectContaining({
        issueId: "#1",
        kind: "missing-branch",
        detail: expect.stringContaining("web"),
      }),
    ]);
  });

  it("defaults to a single 'default' target for legacy callers", async () => {
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    atGate(h, "#1", "feature/#1");
    const r = await resolveStack("#2", "main", h.deps);
    expect(Object.keys(r.repos)).toEqual(["default"]);
    expect(r.repos.default?.prBase).toBe("feature/#1");
  });
});
```

(`Harness.deps` is typed `StackResolveDeps`; assigning `repos` works because the field is optional.)

In `src/core/__tests__/orchestrator-stack.test.ts` add a workspace-mode case (the file's harness takes `project` overrides via `makeTestConfig`; use the same `setupHarness`/`runUntil`/prompt-reading helpers it already has):

```ts
  it("workspace mode: each repo entry carries its own stackPrBase", async () => {
    const repos = [
      { name: "api", path: join(tempDir, "api"), owner: "acme", repo: "api", baseBranch: "origin/main", buildCommand: "b", testCommand: "t", modules: [] },
      { name: "web", path: join(tempDir, "web"), owner: "acme", repo: "web", baseBranch: "origin/develop", buildCommand: "b", testCommand: "t", modules: [] },
    ];
    const h = setupHarness(/* worker returning success as in the other tests */, {
      project: { directory: tempDir, repos, workspaceMode: true },
    });
    // Blocker #1 at the terminal gate with a PR + branch in api only.
    h.pipelineState.create("1", "human-review");
    h.pipelineState.setScope("1", ["api"]);
    h.pipelineState.updateBranchInfo("1", "api", { branchName: "feature/1", prNumber: 10 });
    h.issueTracker.phases.set("1", "human-review");
    h.issueTracker.blockedBy.set("2", [{ id: "1", closed: false }]);
    h.issueTracker.issues.set("2", makeIssue("2", "coding"));
    h.issueTracker.phases.set("2", "coding");
    h.issueTracker.specs.set("2", "spec");
    h.pipelineState.create("2", "coding");
    h.pipelineState.setScope("2", ["api", "web"]);
    h.queue.enqueue({ type: "coding", issueId: "2" });

    await runUntil(h, () => h.runs.length >= 1);

    const prompt = dependentPrompt(); // the file's helper that reads the dispatched prompt for "2"
    expect(prompt).toContain("stackPrBase: feature/1"); // top-level, first target
    expect(prompt).toMatch(/name: api[\s\S]*stackPrBase: feature\/1/);
    expect(prompt).toMatch(/name: web[\s\S]*stackPrBase: develop/);
  });
```

Adapt the harness call to the file's actual `setupHarness` signature (it accepts the worker impl and, if needed, extend it to accept a `project` override the same way `orchestrator.test.ts`'s `HarnessOptions` does: spread `options.project` into the `makeTestConfig({ project: {...} })` call). `join` comes from `node:path`; `makeIssue` from the fixtures.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/__tests__/stack.test.ts src/core/__tests__/orchestrator-stack.test.ts`
Expected: FAIL — `repos` missing on the resolution.

- [ ] **Step 3: Implement `stack.ts`**

Replace from `export interface StackResolution` through the end of `classify` with:

```ts
export interface StackRepoTarget {
  name: string;
  // Bare (no origin/) base branch name for this repo.
  bareBase: string;
}

export interface StackRepoResolution {
  // Ancestor branches to merge in this repo, topologically ordered.
  mergeBranches: string[];
  // Branch this repo's PR targets: the nearest contributing blocker's branch
  // in this repo, else the repo's bare base.
  prBase: string;
}

export interface StackResolution {
  ok: boolean;
  directBlockers: BlockerRef[];
  // Mirror of repos[<first target>] so single-repo callers keep working.
  mergeBranches: string[];
  prBase: string;
  unsatisfied: string[];
  cycle: string[] | null;
  problems: StackProblem[];
  // Per-repo assembly, keyed by repo name.
  repos: Record<string, StackRepoResolution>;
}

export interface StackResolveDeps {
  getBlockedBy(issueId: string): Promise<BlockerRef[]>;
  getPipelineRecord(issueId: string): PipelineRecord | null;
  getTrackerPhase(issueId: string): Promise<string | null>;
  terminalGates: ReadonlySet<string>;
  // Repos to resolve for. Legacy callers omit it and get one target named
  // DEFAULT_REPO_NAME on `bareBase`.
  repos?: readonly StackRepoTarget[];
}
```

(keep `terminalGateNames`, `bareBaseBranch`, `ticketNumber`, `compareTickets` as they are), then:

```ts
type Satisfaction =
  | { state: "satisfied"; branches: ReadonlyMap<string, string> }
  | { state: "unsatisfied" }
  | { state: "missing-branch"; repos: string[] };

function emptyResolution(
  bareBase: string,
  targets: readonly StackRepoTarget[],
  directBlockers: BlockerRef[],
  extra: Pick<StackResolution, "ok" | "unsatisfied" | "cycle" | "problems">,
): StackResolution {
  const repos: Record<string, StackRepoResolution> = {};
  for (const target of targets) {
    repos[target.name] = { mergeBranches: [], prBase: target.bareBase };
  }
  return { ...extra, directBlockers, mergeBranches: [], prBase: bareBase, repos };
}

export async function resolveStack(
  issueId: string,
  bareBase: string,
  deps: StackResolveDeps,
): Promise<StackResolution> {
  const targets: readonly StackRepoTarget[] =
    deps.repos !== undefined && deps.repos.length > 0
      ? deps.repos
      : [{ name: DEFAULT_REPO_NAME, bareBase }];
  // Root lookup failures propagate — the caller defers with <resolve-error>.
  const directBlockers = await deps.getBlockedBy(issueId);
  if (directBlockers.length === 0) {
    return emptyResolution(bareBase, targets, [], {
      ok: true,
      unsatisfied: [],
      cycle: null,
      problems: [],
    });
  }
```

Keep the existing DFS / cycle detection block unchanged, but replace its cycle return with:

```ts
if (cycle !== null) {
  return emptyResolution(bareBase, targets, directBlockers, {
    ok: false,
    unsatisfied: [],
    cycle,
    problems,
  });
}
```

Replace the classification loop and everything after it with:

```ts
  // Classify every walked blocker node (everything except the root).
  const unsatisfied: string[] = [];
  const branchesByNode = new Map<string, ReadonlyMap<string, string>>();
  for (const [id, ref] of refById) {
    let s: Satisfaction;
    try {
      s = await classify(ref, deps);
    } catch (err) {
      if (problems.some((p) => p.issueId === id) === false) {
        problems.push({
          issueId: id,
          kind: "lookup-failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    if (s.state === "satisfied") {
      if (s.branches.size > 0) {
        branchesByNode.set(id, s.branches);
      }
    } else if (s.state === "missing-branch") {
      problems.push({
        issueId: id,
        kind: "missing-branch",
        detail: `${id} is at the terminal gate with a PR but has no recorded branch in ${s.repos.join(", ")}`,
      });
    } else {
      unsatisfied.push(id);
    }
  }

  // Kahn's algorithm over the blocker subgraph, popping the lowest ticket
  // number first so diamond siblings order deterministically.
  const nodes = [...refById.keys()];
  const inDeg = new Map<string, number>(nodes.map((n) => [n, 0]));
  const dependents = new Map<string, string[]>();
  for (const [blocker, dependent] of edges) {
    if (dependent === issueId) {
      continue;
    }
    inDeg.set(dependent, (inDeg.get(dependent) ?? 0) + 1);
    dependents.set(blocker, [...(dependents.get(blocker) ?? []), dependent]);
  }
  const available = nodes.filter((n) => inDeg.get(n) === 0).sort(compareTickets);
  const topoOrder: string[] = [];
  while (available.length > 0) {
    const node = available.shift();
    if (node === undefined) {
      break;
    }
    topoOrder.push(node);
    for (const dep of dependents.get(node) ?? []) {
      const remaining = (inDeg.get(dep) ?? 0) - 1;
      inDeg.set(dep, remaining);
      if (remaining === 0) {
        available.push(dep);
        available.sort(compareTickets);
      }
    }
  }

  const blockersOf = new Map<string, string[]>();
  for (const [blocker, dependent] of edges) {
    blockersOf.set(dependent, [...(blockersOf.get(dependent) ?? []), blocker]);
  }

  // Per repo: merge only the branches blockers pushed in that repo, and base
  // the PR on the nearest contributing blocker by BFS layer (lowest ticket on
  // ties). Bare base only when nothing contributes in that repo — falling back
  // to base while gated ancestor branches exist would let their unreviewed
  // code merge through this PR's diff.
  const repos: Record<string, StackRepoResolution> = {};
  for (const target of targets) {
    const contributes = (id: string): string | undefined => branchesByNode.get(id)?.get(target.name);
    const mergeBranches = topoOrder
      .map(contributes)
      .filter((b): b is string => b !== undefined);
    let prBase = target.bareBase;
    const visited = new Set<string>([issueId]);
    let frontier = [issueId];
    while (frontier.length > 0) {
      const layer = [...new Set(frontier.flatMap((id) => blockersOf.get(id) ?? []))].filter(
        (id) => visited.has(id) === false,
      );
      for (const id of layer) {
        visited.add(id);
      }
      const contributor = layer.filter((id) => contributes(id) !== undefined).sort(compareTickets)[0];
      if (contributor !== undefined) {
        prBase = contributes(contributor) ?? target.bareBase;
        break;
      }
      frontier = layer;
    }
    repos[target.name] = { mergeBranches, prBase };
  }
  const first = targets[0];
  const primary = first === undefined ? undefined : repos[first.name];

  return {
    ok: unsatisfied.length === 0 && problems.length === 0,
    directBlockers,
    mergeBranches: primary?.mergeBranches ?? [],
    prBase: primary?.prBase ?? bareBase,
    unsatisfied: unsatisfied.sort(compareTickets),
    cycle: null,
    problems,
    repos,
  };
}

async function classify(ref: BlockerRef, deps: StackResolveDeps): Promise<Satisfaction> {
  const rec = deps.getPipelineRecord(ref.id);
  if (rec?.currentPhase === "done") {
    // Merged to base (or into a parent's branch — the lineage walk covers
    // that): the blocker itself has nothing left to contribute.
    return { state: "satisfied", branches: new Map() };
  }
  if (ref.closed) {
    // Done/cancelled outside RQ, or auto-closed by its merged PR.
    return { state: "satisfied", branches: new Map() };
  }
  if (rec === null) {
    return { state: "unsatisfied" };
  }
  // Every in-scope row needs a PR before the gate test can pass — skip the
  // tracker call otherwise rather than spend one API call per blocker per sweep.
  const rows = rec.repos.filter((row) => row.inScope);
  if (rows.length === 0 || rows.some((row) => row.prNumber === null)) {
    return { state: "unsatisfied" };
  }
  // The tracker is authoritative for the gate test — the local phase cache
  // misses manual phase moves and webhook-less deployments.
  const phase = await deps.getTrackerPhase(ref.id);
  if (phase === null || deps.terminalGates.has(phase) === false) {
    return { state: "unsatisfied" };
  }
  const branches = new Map<string, string>();
  const missing: string[] = [];
  for (const row of rows) {
    if (row.branchName === null) {
      missing.push(row.repo);
    } else {
      branches.set(row.repo, row.branchName);
    }
  }
  if (missing.length > 0) {
    return { state: "missing-branch", repos: missing };
  }
  return { state: "satisfied", branches };
}
```

Add `import { DEFAULT_REPO_NAME } from "./pipeline-state.js";` at the top of `stack.ts`.

- [ ] **Step 4: Wire the orchestrator and `pr create`**

`src/core/orchestrator.ts` `guardStackBlockers`:

```ts
    const repoTargets = this.deps.runtime.config.project.repos.map((repo) => ({
      name: repo.name,
      bareBase: bareBaseBranch(repo.baseBranch),
    }));
    let resolution: StackResolution;
    try {
      resolution = await resolveStack(
        issueId,
        repoTargets[0]?.bareBase ?? bareBaseBranch(this.deps.runtime.config.pipeline.baseBranch),
        {
          getBlockedBy: (id) => this.deps.issueTracker.getBlockedBy(id),
          getPipelineRecord: (id) => this.deps.pipelineState.get(id),
          getTrackerPhase: (id) => this.deps.issueTracker.getPhase(id),
          terminalGates: terminalGateNames(this.deps.runtime.phaseGraph),
          repos: repoTargets,
        },
      );
```

and the "nothing to assemble" check:

```ts
const nothingToMerge = Object.values(resolution.repos).every((r) => r.mergeBranches.length === 0);
if (nothingToMerge) {
  return { action: "proceed", stack: null };
}
this.deps.audit.log({
  component: "orchestrator",
  issueId,
  message: `Stack resolved: ${Object.entries(resolution.repos)
    .map(([name, r]) => `${name}: merge [${r.mergeBranches.join(", ")}] → base ${r.prBase}`)
    .join("; ")}`,
  metadata: { taskId: task.id, phase: phase.name, repos: resolution.repos },
});
```

In `dispatchWorkerForTask`'s `buildSkillContext({...})` call add:

```ts
      repoPrBases:
        stack === null
          ? undefined
          : Object.fromEntries(Object.entries(stack.repos).map(([name, r]) => [name, r.prBase])),
```

`src/cli/pr.ts` `cmdPrCreate`: pass `repos: ctx.config.project.repos.map((r) => ({ name: r.name, bareBase: bareBaseBranch(r.baseBranch) }))` in the `resolveStack` deps and use the per-repo base:

```ts
if (resolution.ok && resolution.directBlockers.length > 0) {
  resolvedBase = resolution.repos[repo.name]?.prBase ?? resolution.prBase;
}
```

(`repo` is the `resolveRepoArg` result from plan 1 Task 5; also pass `bareBaseBranch(repo.baseBranch)` as the second `resolveStack` argument.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/core/__tests__/stack.test.ts src/core/__tests__/orchestrator-stack.test.ts src/cli/__tests__/stack.test.ts`
Expected: PASS.

- [ ] **Step 6: Check + commit**

```bash
npm run check
git add src/core/stack.ts src/core/orchestrator.ts src/cli/pr.ts src/core/__tests__/stack.test.ts src/core/__tests__/orchestrator-stack.test.ts
git commit -m "feat(stack): resolve blockers per repo so PR bases and merge branches follow the repo"
```

---

### Task 3: Worktree layout, webhook `repo`, and per-row merge processing

**Files:**

- Create: `src/core/worktree-layout.ts`
- Modify: `src/integrations/github/webhook.ts:83-107` (`pr-merged`), `:149-178` (`buildFeedbackEvent`)
- Modify: `src/webhook/server.ts` (whole `pr-merged` case, `runMergedPrScan`, `cleanupLocalBranchArtifacts`, `retargetAndRefreshDependents`, `refreshDependentBranch`, `retryPendingMergeCleanup`, `classifyMergedPrEvent`)
- Modify: `src/index.ts` (export layout helpers)
- Test: `src/core/__tests__/worktree-layout.test.ts` (new), `src/integrations/github/__tests__/webhook.test.ts`, `src/webhook/__tests__/server.test.ts`

**Interfaces:**

- Produces:
  ```ts
  // src/core/worktree-layout.ts
  export type WorktreeKind = "coding" | "spec" | "refresh";
  export function worktreePathFor(
    config: RedQueenConfig,
    issueId: string,
    repoName: string,
    kind?: WorktreeKind,
  ): string;
  export function repoConfigOf(config: RedQueenConfig, repoName: string): RepoConfig; // throws listing valid names
  export function gitCwdFor(config: RedQueenConfig, repoName: string): string; // repoConfigOf(...).path
  ```
- Event payloads: GitHub `pr-merged` / `pr-feedback` gain `repo: "<owner>/<repo>"`. Poll-sourced `pr-merged` events carry `repoName: <config name>` instead.
- `cleanupLocalBranchArtifacts(issueId, repo, worktreePath, branchName, component, context)` — git cwd is `gitCwdFor(config, repo)`.
- `refreshDependentBranch(issueId, repo, depBranch, prNumber, mergedBase, component)` — temp worktree at `worktreePathFor(config, issueId, repo, "refresh")`, git cwd `gitCwdFor(config, repo)`.
- Pending merge cleanup is keyed per `(issueId, repo)`.

- [ ] **Step 1: Write the failing tests**

`src/core/__tests__/worktree-layout.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeTestConfig } from "./fixtures/test-config.js";
import { gitCwdFor, repoConfigOf, worktreePathFor } from "../worktree-layout.js";

const repos = [
  {
    name: "api",
    path: "/srv/ws/api",
    owner: "o",
    repo: "api",
    baseBranch: "origin/main",
    buildCommand: "b",
    testCommand: "t",
    modules: [],
  },
  {
    name: "web",
    path: "/srv/ws/web",
    owner: "o",
    repo: "web",
    baseBranch: "origin/main",
    buildCommand: "b",
    testCommand: "t",
    modules: [],
  },
];

describe("worktreePathFor", () => {
  it("nests one directory per repo under the ticket directory in workspace mode", () => {
    const config = makeTestConfig({
      project: { directory: "/srv/ws", repos, workspaceMode: true },
    });
    expect(worktreePathFor(config, "PROJ-1", "api")).toBe("/srv/ws/.redqueen/worktrees/PROJ-1/api");
    expect(worktreePathFor(config, "PROJ-1", "web", "spec")).toBe(
      "/srv/ws/.redqueen/worktrees/spec-PROJ-1/web",
    );
    expect(worktreePathFor(config, "PROJ-1", "web", "refresh")).toBe(
      "/srv/ws/.redqueen/worktrees/refresh-PROJ-1/web",
    );
  });

  it("keeps the flat legacy layout", () => {
    const config = makeTestConfig({ project: { directory: "/srv/app" } });
    expect(worktreePathFor(config, "PROJ-1", "app")).toBe("/srv/app/.redqueen/worktrees/PROJ-1");
    expect(worktreePathFor(config, "PROJ-1", "app", "refresh")).toBe(
      "/srv/app/.redqueen/worktrees/refresh-PROJ-1",
    );
  });
});

describe("gitCwdFor / repoConfigOf", () => {
  it("returns the repo's own path and rejects unknown names", () => {
    const config = makeTestConfig({
      project: { directory: "/srv/ws", repos, workspaceMode: true },
    });
    expect(gitCwdFor(config, "web")).toBe("/srv/ws/web");
    expect(repoConfigOf(config, "api").name).toBe("api");
    expect(() => gitCwdFor(config, "nope")).toThrow(/Unknown repo "nope".*api, web/);
  });

  it("legacy mode resolves to project.directory", () => {
    const config = makeTestConfig({ project: { directory: "/srv/app" } });
    expect(gitCwdFor(config, "app")).toBe("/srv/app");
  });
});
```

`src/integrations/github/__tests__/webhook.test.ts` — add inside the `parseGitHubWebhookEvent` describe:

```ts
it("carries repository.full_name as repo on pr-merged and pr-feedback", () => {
  const merged = parseGitHubWebhookEvent(
    { identity },
    { "x-github-event": "pull_request" },
    JSON.stringify({
      action: "closed",
      sender: { id: 2, login: "human" },
      repository: { full_name: "acme/App" },
      pull_request: {
        merged: true,
        number: 7,
        head: { ref: "feature/PROJ-1" },
        base: { ref: "main" },
      },
    }),
  );
  expect(merged?.payload).toEqual({
    branch: "feature/PROJ-1",
    base: "main",
    prNumber: 7,
    repo: "acme/App",
  });

  const feedback = parseGitHubWebhookEvent(
    { identity },
    { "x-github-event": "issue_comment" },
    JSON.stringify({
      action: "created",
      sender: { id: 2, login: "human" },
      repository: { full_name: "acme/App" },
      issue: { number: 5, pull_request: { head: { ref: "feature/PROJ-1" } } },
    }),
  );
  expect(feedback?.payload).toEqual({ branch: "feature/PROJ-1", repo: "acme/App" });
});
```

`src/webhook/__tests__/server.test.ts` — add a new describe (model it on the existing "pr-merged cleanup" describe at ~line 520, which builds a `WebhookServer` with a recording `gitRunner`; reuse its `tempDir`/db setup style). Register two repos and two mock adapters:

```ts
describe("WebhookServer multi-repo pr-merged", () => {
  // setup: db, queue, pipelineState = new PipelineStateStore(db, ["api", "web"]), audit,
  // apiSc = new MockSourceControl(), webSc = new MockSourceControl(),
  // config = makeTestConfig({ project: { directory: tempDir, workspaceMode: true, repos: [
  //   { name: "api", path: join(tempDir, "api"), owner: "acme", repo: "Api", baseBranch: "origin/main", buildCommand: "b", testCommand: "t", modules: [] },
  //   { name: "web", path: join(tempDir, "web"), owner: "acme", repo: "Web", baseBranch: "origin/main", buildCommand: "b", testCommand: "t", modules: [] },
  // ] } }),
  // gitCalls: { args: string[]; cwd: string }[] = [] recorded by gitRunner,
  // webhook = new WebhookServer({ issueTracker, sourceControls: createSourceControlRegistry([
  //   { name: "api", fullName: "acme/Api", adapter: apiSc }, { name: "web", fullName: "acme/Web", adapter: webSc } ]),
  //   queue, pipelineState, runtime: new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), config), audit, gitRunner })
  // and a `dispatch(event)` helper that calls the private dispatchEvent via the registered route or
  // `(webhook as unknown as { dispatchEvent: (e: PipelineEvent, c: string) => Promise<void> }).dispatchEvent(event, "test")`
  // — the existing describe blocks in this file show which approach they use; follow it.

  it("marks the row terminal, cleans up at the repo path, and leaves the issue open until the last PR merges", async () => {
    pipelineState.create("PROJ-1", "human-review");
    pipelineState.setScope("PROJ-1", ["api", "web"]);
    mkdirSync(join(tempDir, "wt-api"), { recursive: true });
    pipelineState.updateBranchInfo("PROJ-1", "api", {
      branchName: "feature/PROJ-1",
      prNumber: 1,
      prBaseBranch: "main",
      worktreePath: join(tempDir, "wt-api"),
    });
    pipelineState.updateBranchInfo("PROJ-1", "web", {
      branchName: "feature/PROJ-1",
      prNumber: 1,
      prBaseBranch: "main",
    });

    await dispatch({
      source: "webhook",
      type: "pr-merged",
      issueId: "PROJ-1",
      timestamp: new Date().toISOString(),
      payload: { branch: "feature/PROJ-1", base: "main", prNumber: 1, repo: "acme/Api" },
    });

    expect(pipelineState.getRepo("PROJ-1", "api")).toMatchObject({
      prNumber: null,
      terminalPrNumber: 1,
      branchName: null,
      worktreePath: null,
    });
    expect(pipelineState.getRepo("PROJ-1", "web")).toMatchObject({
      prNumber: 1,
      branchName: "feature/PROJ-1",
    });
    expect(pipelineState.get("PROJ-1")?.currentPhase).toBe("human-review");
    expect(gitCalls).toEqual([
      {
        args: ["worktree", "remove", "--force", "--", join(tempDir, "wt-api")],
        cwd: join(tempDir, "api"),
      },
      { args: ["branch", "-D", "--", "feature/PROJ-1"], cwd: join(tempDir, "api") },
    ]);

    await dispatch({
      source: "webhook",
      type: "pr-merged",
      issueId: "PROJ-1",
      timestamp: new Date().toISOString(),
      payload: { branch: "feature/PROJ-1", base: "main", prNumber: 1, repo: "acme/Web" },
    });

    expect(pipelineState.get("PROJ-1")?.currentPhase).toBe("done");
    expect(gitCalls.at(-1)).toEqual({
      args: ["branch", "-D", "--", "feature/PROJ-1"],
      cwd: join(tempDir, "web"),
    });
  });

  it("drops an event for an unknown full name and audits it", async () => {
    pipelineState.create("PROJ-2", "human-review");
    pipelineState.updateBranchInfo("PROJ-2", "api", { prNumber: 3 });
    await dispatch({
      source: "webhook",
      type: "pr-merged",
      issueId: "PROJ-2",
      timestamp: new Date().toISOString(),
      payload: { prNumber: 3, repo: "someone/else" },
    });
    expect(pipelineState.getRepo("PROJ-2", "api")?.prNumber).toBe(3);
    expect(
      audit
        .query({ issueId: "PROJ-2", limit: 10 })
        .some((e) => e.message.includes("unknown repo someone/else")),
    ).toBe(true);
  });

  it("a descoped row's merge cleans up but never advances the issue", async () => {
    pipelineState.create("PROJ-3", "human-review");
    pipelineState.setScope("PROJ-3", ["api", "web"]);
    pipelineState.updateBranchInfo("PROJ-3", "api", { branchName: "feature/PROJ-3", prNumber: 4 });
    pipelineState.updateBranchInfo("PROJ-3", "web", { branchName: "feature/PROJ-3", prNumber: 4 });
    pipelineState.setScope("PROJ-3", ["web"]);
    await dispatch({
      source: "webhook",
      type: "pr-merged",
      issueId: "PROJ-3",
      timestamp: new Date().toISOString(),
      payload: { branch: "feature/PROJ-3", base: "main", prNumber: 4, repo: "acme/Api" },
    });
    expect(pipelineState.getRepo("PROJ-3", "api")).toMatchObject({
      prNumber: null,
      terminalPrNumber: 4,
      branchName: null,
    });
    expect(pipelineState.get("PROJ-3")?.currentPhase).toBe("human-review");
  });

  it("reconcileMergedPrs replays merges per row through each repo's adapter", async () => {
    pipelineState.create("PROJ-4", "human-review");
    pipelineState.setScope("PROJ-4", ["api", "web"]);
    const apiPr = await apiSc.createPullRequest({
      title: "t",
      body: "",
      head: "feature/PROJ-4",
      base: "main",
      draft: false,
    });
    const webPr = await webSc.createPullRequest({
      title: "t",
      body: "",
      head: "feature/PROJ-4",
      base: "main",
      draft: false,
    });
    pipelineState.updateBranchInfo("PROJ-4", "api", {
      branchName: "feature/PROJ-4",
      prNumber: apiPr.number,
    });
    pipelineState.updateBranchInfo("PROJ-4", "web", {
      branchName: "feature/PROJ-4",
      prNumber: webPr.number,
    });
    await webSc.mergePullRequest(webPr.number);

    await webhook.reconcileMergedPrs();

    expect(pipelineState.getRepo("PROJ-4", "web")?.prNumber).toBeNull();
    expect(pipelineState.getRepo("PROJ-4", "api")?.prNumber).toBe(apiPr.number);
    expect(pipelineState.get("PROJ-4")?.currentPhase).toBe("human-review");
  });

  it("refreshes a dependent's branch in the merged repo using the nested refresh worktree", async () => {
    // blocker PROJ-5 merged in api; dependent PROJ-6 has an open api PR targeting feature/PROJ-5
    pipelineState.create("PROJ-5", "human-review");
    pipelineState.updateBranchInfo("PROJ-5", "api", {
      branchName: "feature/PROJ-5",
      prNumber: 10,
      prBaseBranch: "main",
    });
    pipelineState.create("PROJ-6", "coding");
    pipelineState.setScope("PROJ-6", ["api", "web"]);
    const depPr = await apiSc.createPullRequest({
      title: "t",
      body: "",
      head: "feature/PROJ-6",
      base: "feature/PROJ-5",
      draft: false,
    });
    pipelineState.updateBranchInfo("PROJ-6", "api", {
      branchName: "feature/PROJ-6",
      prNumber: depPr.number,
      prBaseBranch: "feature/PROJ-5",
    });
    pipelineState.updateBranchInfo("PROJ-6", "web", {
      branchName: "feature/PROJ-6",
      prNumber: 99,
      prBaseBranch: "main",
    });
    gitCalls.length = 0;

    await dispatch({
      source: "webhook",
      type: "pr-merged",
      issueId: "PROJ-5",
      timestamp: new Date().toISOString(),
      payload: { branch: "feature/PROJ-5", base: "main", prNumber: 10, repo: "acme/Api" },
    });

    expect(apiSc.calls).toContain(`updatePullRequestBase:${String(depPr.number)}:main`);
    expect(pipelineState.getRepo("PROJ-6", "api")?.prBaseBranch).toBe("main");
    expect(pipelineState.getRepo("PROJ-6", "web")?.prBaseBranch).toBe("main"); // untouched
    const refreshDir = join(tempDir, ".redqueen", "worktrees", "refresh-PROJ-6", "api");
    expect(gitCalls).toContainEqual({
      args: ["worktree", "add", "--detach", refreshDir, "origin/feature/PROJ-6"],
      cwd: join(tempDir, "api"),
    });
    expect(gitCalls).toContainEqual({
      args: ["push", "origin", "HEAD:feature/PROJ-6"],
      cwd: refreshDir,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/__tests__/worktree-layout.test.ts src/integrations/github/__tests__/webhook.test.ts src/webhook/__tests__/server.test.ts`
Expected: FAIL — module missing, `repo` absent from payloads, cwd assertions fail.

- [ ] **Step 3: Implement `worktree-layout.ts`**

```ts
import { join } from "node:path";
import type { RedQueenConfig, RepoConfig } from "./config.js";

export type WorktreeKind = "coding" | "spec" | "refresh";

// Workspace mode nests one directory per repo under the ticket directory so a
// cross-repo change-set lives together; legacy mode keeps the flat layout so
// in-flight worktrees and byte-identical prompts hold.
export function worktreePathFor(
  config: RedQueenConfig,
  issueId: string,
  repoName: string,
  kind: WorktreeKind = "coding",
): string {
  const dirName = kind === "coding" ? issueId : `${kind}-${issueId}`;
  const ticketDir = join(config.project.directory, ".redqueen", "worktrees", dirName);
  return config.project.workspaceMode ? join(ticketDir, repoName) : ticketDir;
}

export function repoConfigOf(config: RedQueenConfig, repoName: string): RepoConfig {
  const repo = config.project.repos.find((r) => r.name === repoName);
  if (repo === undefined) {
    const valid = config.project.repos.map((r) => r.name).join(", ");
    throw new Error(`Unknown repo "${repoName}" — valid repos: ${valid}`);
  }
  return repo;
}

// Every git invocation runs from the acting repo's own work tree: the
// workspace root is not a repository.
export function gitCwdFor(config: RedQueenConfig, repoName: string): string {
  return repoConfigOf(config, repoName).path;
}
```

Export all three from `src/index.ts`.

- [ ] **Step 4: Add `repo` to the GitHub webhook payloads**

In `src/integrations/github/webhook.ts`:

```ts
    case "pull_request": {
      const action = extractString(payload, "action");
      const merged = extractNested(payload, ["pull_request", "merged"]);
      if (action === "closed" && merged === true) {
        const headRef = extractNested(payload, ["pull_request", "head", "ref"]);
        const branch = typeof headRef === "string" ? headRef : null;
        const issueId = branch === null ? null : resolver(branch);
        if (issueId === null) {
          return null;
        }
        // The merged PR's own base — where stacked dependents retarget to.
        const baseRef = extractNested(payload, ["pull_request", "base", "ref"]);
        const prNumber = extractNested(payload, ["pull_request", "number"]);
        return {
          source: "webhook",
          type: "pr-merged",
          issueId,
          timestamp: nowIso,
          payload: {
            branch,
            ...(typeof baseRef === "string" ? { base: baseRef } : {}),
            ...(typeof prNumber === "number" ? { prNumber } : {}),
            ...repoField(payload),
          },
        };
      }
      return null;
    }
```

and in `buildFeedbackEvent` the return becomes `payload: { branch, ...repoField(payload) }`. Add:

```ts
// owner/repo of the event's repository — the webhook server routes PR events
// to the matching repo adapter and pipeline row with it.
function repoField(payload: Record<string, unknown>): { repo?: string } {
  const fullName = extractNested(payload, ["repository", "full_name"]);
  return typeof fullName === "string" ? { repo: fullName } : {};
}
```

- [ ] **Step 5: Rewrite the webhook server's merge path**

In `src/webhook/server.ts`:

(a) Imports: add `import { gitCwdFor, worktreePathFor } from "../core/worktree-layout.js";`, `import { classifyRepoMergeTransition, primaryRepoName } from "../core/pipeline-state.js";` (drop `classifyMergeTransition`), and `import type { PipelineRepoRecord } from "../core/types.js";`. Remove the `adapterFor` helper added in plan 1 once the sites below no longer use it.

(b) Pending cleanup per row:

```ts
interface PendingMergeCleanup {
  event: PipelineEvent;
  repo: string;
  expectedPrNumber: number | null;
}

function pendingKey(issueId: string, repo: string): string {
  return `${issueId} ${repo}`;
}
```

(c) Replace the whole `case "pr-merged":` block with:

```ts
      case "pr-merged": {
        const record = pipelineState.get(event.issueId);
        const mergedPrNumber = extractNumber(event.payload, "prNumber");
        if (record === null) {
          audit.log({
            component,
            issueId: event.issueId,
            message: "PR merged — no pipeline record, skipping local cleanup",
            metadata: {},
          });
          break;
        }
        const repoName = this.resolveEventRepo(event, record, component);
        if (repoName === null) {
          break;
        }
        const row = record.repos.find((r) => r.repo === repoName) ?? null;
        if (row === null) {
          audit.log({
            component,
            issueId: event.issueId,
            message: `PR merged in ${repoName}, but the issue has no row for that repo — ignoring`,
            metadata: { repo: repoName, mergedPrNumber },
          });
          break;
        }
        const mergedBranch = extractString(event.payload, "branch") ?? row.branchName;
        const mergedBase = extractString(event.payload, "base") ?? row.prBaseBranch;
        const disposition = classifyMergedPrEvent(record.currentPhase, row, mergedPrNumber, mergedBranch);
        if (disposition !== "process") {
          this.pendingMergeCleanup.delete(pendingKey(event.issueId, repoName));
          audit.log({
            component,
            issueId: event.issueId,
            message:
              disposition === "already-processed"
                ? `PR #${String(mergedPrNumber)} (${repoName}) merge cleanup was already processed — ignoring duplicate delivery`
                : `PR #${String(mergedPrNumber)} (${repoName}) merged, but it belongs to an earlier pipeline run — ignoring stale cleanup`,
            metadata: {
              repo: repoName,
              mergedPrNumber,
              currentPrNumber: row.prNumber,
              terminalPrNumber: row.terminalPrNumber,
              mergedBranch,
              currentBranch: row.branchName,
            },
          });
          break;
        }
        const working = queue
          .listByStatus("working")
          .some((task) => task.issueId === event.issueId);
        if (working) {
          const expectedPrNumber = mergedPrNumber ?? row.prNumber;
          this.pendingMergeCleanup.set(pendingKey(event.issueId, repoName), {
            repo: repoName,
            expectedPrNumber,
            event: {
              ...event,
              payload: {
                ...event.payload,
                repoName,
                ...(expectedPrNumber === null ? {} : { prNumber: expectedPrNumber }),
                ...(mergedBranch === null ? {} : { branch: mergedBranch }),
                ...(mergedBase === null ? {} : { base: mergedBase }),
              },
            },
          });
          audit.log({
            component,
            issueId: event.issueId,
            message: `PR merged (${repoName}) — cleanup deferred because the issue has a working task`,
            metadata: { repo: repoName, prNumber: row.prNumber, worktreePath: row.worktreePath, branchName: row.branchName },
          });
          break;
        }

        const transition = pipelineState.markPrMerged(event.issueId, repoName, mergedPrNumber);
        this.pendingMergeCleanup.delete(pendingKey(event.issueId, repoName));
        if (transition !== "processed" && transition !== "pending-others") {
          audit.log({
            component,
            issueId: event.issueId,
            message: `PR merge cleanup skipped after state recheck: ${transition}`,
            metadata: { repo: repoName, mergedPrNumber },
          });
          break;
        }
        const cancelledTasks =
          transition === "processed"
            ? queue.cancelPendingForIssue(event.issueId, "Cancelled — pull request merged")
            : 0;

        await this.cleanupLocalBranchArtifacts(
          event.issueId,
          repoName,
          row.worktreePath,
          row.branchName,
          component,
          "pr-merged cleanup",
        );
        const remaining = pipelineState
          .listRepos(event.issueId)
          .filter((r) => r.inScope && r.prNumber !== null).length;
        audit.log({
          component,
          issueId: event.issueId,
          message:
            transition === "processed"
              ? `PR merged (${repoName}) — every in-scope PR is merged; pipeline marked done, local cleanup complete`
              : `PR merged (${repoName}) — row cleaned up; ${String(remaining)} in-scope PR(s) still open`,
          metadata: {
            repo: repoName,
            hadWorktree: row.worktreePath !== null,
            hadBranch: row.branchName !== null,
            cancelledTasks,
            inScope: row.inScope,
            remainingOpenPrs: remaining,
          },
        });

        // Stacked dependents in the same repo: retarget their PRs off the merged
        // branch and deterministically fold the merged base into their branches.
        if (mergedBranch !== null && mergedBase !== null) {
          const run = this.refreshChain.then(() =>
            this.retargetAndRefreshDependents(event.issueId, repoName, mergedBranch, mergedBase, component),
          );
          this.refreshChain = run.catch(() => undefined);
          await run;
        }

        if (transition === "processed") {
          queue.releaseDeferred();
        }
        break;
      }
```

(d) Add the resolver:

```ts
  // Poll-sourced replays name the row directly; GitHub deliveries carry the
  // repository full name, which must map to a configured repo. Events with
  // neither (mock adapters) act on the record's primary row.
  private resolveEventRepo(
    event: PipelineEvent,
    record: PipelineRecord,
    component: string,
  ): string | null {
    const named = extractString(event.payload, "repoName");
    if (named !== null) {
      return named;
    }
    const fullName = extractString(event.payload, "repo");
    if (fullName === null) {
      return primaryRepoName(record, this.deps.pipelineState.defaultRepo);
    }
    const entry = this.deps.sourceControls.byFullName(fullName);
    if (entry === null) {
      this.deps.audit.log({
        component,
        issueId: event.issueId,
        message: `${event.type} for unknown repo ${fullName} — dropped (configured: ${this.deps.sourceControls.names().join(", ")})`,
        metadata: { repo: fullName },
      });
      return null;
    }
    return entry.name;
  }
```

(e) `retryPendingMergeCleanup(issueId)` iterates every pending entry for the issue:

```ts
  async retryPendingMergeCleanup(issueId: string): Promise<void> {
    const record = this.deps.pipelineState.get(issueId);
    for (const [key, pending] of [...this.pendingMergeCleanup.entries()]) {
      if (key.startsWith(`${issueId} `) === false) {
        continue;
      }
      const row = record?.repos.find((r) => r.repo === pending.repo) ?? null;
      const prChanged =
        row !== null &&
        (pending.expectedPrNumber === null
          ? row.prNumber !== null
          : row.prNumber !== null && row.prNumber !== pending.expectedPrNumber);
      if (record === null || row === null || prChanged) {
        this.pendingMergeCleanup.delete(key);
        safeAudit(this.deps.audit, {
          component: "webhook-reconcile",
          issueId,
          message: "Deferred merged-PR cleanup discarded because the row now has a different PR",
          metadata: { repo: pending.repo, expectedPrNumber: pending.expectedPrNumber, currentPrNumber: row?.prNumber ?? null },
        });
        continue;
      }
      await this.dispatchEvent(pending.event, "webhook-reconcile");
    }
  }
```

(f) `runMergedPrScan` per row:

```ts
  private async runMergedPrScan(): Promise<void> {
    const component = "webhook-reconcile";
    const { pipelineState } = this.deps;
    const all = pipelineState.listAll();

    // A crash between markPrMerged's commit and the git cleanup leaves exactly
    // this row signature on a done issue — PR nulled, terminal PR recorded,
    // branch info still set. Finish the cleanup from local state alone.
    for (const record of all) {
      if (record.currentPhase !== "done") {
        continue;
      }
      for (const row of record.repos) {
        const leaked =
          row.prNumber === null &&
          row.terminalPrNumber !== null &&
          (row.branchName !== null || row.worktreePath !== null);
        if (leaked === false) {
          continue;
        }
        safeAudit(this.deps.audit, {
          component,
          issueId: record.issueId,
          message: `PR #${String(row.terminalPrNumber)} (${row.repo}) merge cleanup never finished — sweeping leftover branch artifacts`,
          metadata: { repo: row.repo, branchName: row.branchName, worktreePath: row.worktreePath },
        });
        try {
          await this.cleanupLocalBranchArtifacts(record.issueId, row.repo, row.worktreePath, row.branchName, component, "merge cleanup sweep");
        } catch (err) {
          safeAudit(this.deps.audit, {
            component,
            issueId: record.issueId,
            message: `merge cleanup sweep failed: ${errorMessage(err)}`,
            metadata: { repo: row.repo },
          });
        }
      }
    }

    const openRows: { record: PipelineRecord; row: PipelineRepoRecord }[] = [];
    for (const record of all) {
      if (record.currentPhase === "done") {
        continue;
      }
      for (const row of record.repos) {
        if (row.prNumber !== null && row.terminalPrNumber !== row.prNumber) {
          openRows.push({ record, row });
        }
      }
    }
    const candidates = await mapWithConcurrency(
      openRows,
      MERGE_LOOKUP_CONCURRENCY,
      async ({ record, row }): Promise<MergedPrCandidate | null> => {
        const prNumber = row.prNumber;
        if (prNumber === null) {
          return null;
        }
        try {
          const pr = await withTimeout(
            this.deps.sourceControls.get(row.repo).getPullRequest(prNumber),
            REMOTE_LOOKUP_TIMEOUT_MS,
            `getPullRequest ${row.repo}#${String(prNumber)}`,
          );
          if (pr === null || pr.merged === false) {
            return null;
          }
          return { record, row, pr };
        } catch (err) {
          safeAudit(this.deps.audit, {
            component,
            issueId: record.issueId,
            message: `merged-PR lookup failed for ${row.repo}#${String(prNumber)}: ${errorMessage(err)}`,
            metadata: { repo: row.repo, prNumber },
          });
          return null;
        }
      },
    );

    for (const candidate of candidates) {
      if (candidate === null) {
        continue;
      }
      const { record, row, pr } = candidate;
      try {
        safeAudit(this.deps.audit, {
          component,
          issueId: record.issueId,
          message: `PR ${row.repo}#${String(row.prNumber)} is merged but no pr-merged event was processed — replaying (check the source-control webhook on that repo)`,
          metadata: { repo: row.repo, prNumber: row.prNumber, phase: record.currentPhase },
        });
        await this.dispatchEvent(
          {
            source: "poll",
            type: "pr-merged",
            issueId: record.issueId,
            timestamp: new Date().toISOString(),
            payload: { branch: pr.headBranch, base: pr.baseBranch, prNumber: pr.number, repoName: row.repo },
          },
          component,
        );
      } catch (err) {
        safeAudit(this.deps.audit, {
          component,
          issueId: record.issueId,
          message: `merged-PR reconcile failed for ${row.repo}#${String(row.prNumber)}: ${errorMessage(err)}`,
          metadata: { repo: row.repo, prNumber: row.prNumber },
        });
      }
    }
  }
```

and change `MergedPrCandidate` to `{ record: PipelineRecord; row: PipelineRepoRecord; pr: PullRequest }`.

(g) `cleanupLocalBranchArtifacts` gains `repo` and uses the repo's cwd:

```ts
  private async cleanupLocalBranchArtifacts(
    issueId: string,
    repo: string,
    worktreePath: string | null,
    branchName: string | null,
    component: string,
    context: string,
  ): Promise<void> {
    const cwd = gitCwdFor(this.deps.runtime.config, repo);
    if (worktreePath !== null && existsSync(worktreePath)) {
      try {
        await this.gitRunner(["worktree", "remove", "--force", "--", worktreePath], cwd);
      } catch (err) {
        safeAudit(this.deps.audit, { component, issueId, message: `${context}: git worktree remove failed: ${errorMessage(err)}`, metadata: { repo, worktreePath } });
      }
    }
    if (branchName !== null) {
      try {
        await this.gitRunner(["branch", "-D", "--", branchName], cwd);
      } catch (err) {
        safeAudit(this.deps.audit, { component, issueId, message: `${context}: git branch -D failed: ${errorMessage(err)}`, metadata: { repo, branchName } });
      }
    }
    this.deps.pipelineState.updateBranchInfo(issueId, repo, { branchName: null, worktreePath: null });
  }
```

(h) `retargetAndRefreshDependents(mergedIssueId, mergedRepo, mergedBranch, mergedBase, component)`: iterate `pipelineState.listAll()`, skip `rec.issueId === mergedIssueId || rec.currentPhase === "done"`, take `const row = rec.repos.find((r) => r.repo === mergedRepo)`, skip when `row === undefined || row.prNumber === null`, use `this.deps.sourceControls.get(mergedRepo)` for `getPullRequest`/`updatePullRequestBase`, replace `rec.prBaseBranch` with `row.prBaseBranch`, `pipelineState.updateBranchInfo(rec.issueId, mergedRepo, { prBaseBranch: mergedBase })`, `rec.branchName` with `row.branchName`, and call `this.refreshDependentBranch(rec.issueId, mergedRepo, row.branchName, row.prNumber, mergedBase, component)`. Audit messages include `repo: mergedRepo`.

(i) `refreshDependentBranch(issueId, repo, depBranch, prNumber, mergedBase, component)`:

```ts
const config = this.deps.runtime.config;
const cwd = gitCwdFor(config, repo);
const tempWorktree = worktreePathFor(config, issueId, repo, "refresh");
```

Every `projectDir` argument in the body becomes `cwd`; the conflict comment goes through `this.deps.sourceControls.get(repo).postPrComment(...)`.

(j) `classifyMergedPrEvent`:

```ts
function classifyMergedPrEvent(
  currentPhase: string | null,
  row: PipelineRepoRecord,
  mergedPrNumber: number | null,
  mergedBranch: string | null,
): "process" | "already-processed" | "stale" {
  const disposition = classifyRepoMergeTransition(currentPhase, row, mergedPrNumber);
  if (disposition !== "process") {
    return disposition;
  }
  // Webhook-only layer: with no PR number to match on, a branch mismatch is
  // the remaining signal that the event belongs to an earlier pipeline run.
  if (
    row.prNumber === null &&
    row.branchName !== null &&
    mergedBranch !== null &&
    row.branchName !== mergedBranch
  ) {
    return "stale";
  }
  return "process";
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/core/__tests__/worktree-layout.test.ts src/integrations/github src/webhook src/core/__tests__/orchestrator.test.ts`
Expected: PASS. Existing single-repo webhook tests keep passing because events without `repo` resolve to the record's primary row and legacy `gitCwdFor` equals `project.directory`.

- [ ] **Step 7: Check + commit**

```bash
npm run check
git add src/core/worktree-layout.ts src/core/__tests__/worktree-layout.test.ts src/integrations/github src/webhook src/index.ts
git commit -m "feat(webhook): route PR events by repo and finish tickets only after the last in-scope merge"
```

---

### Task 4: Reconciler skip over in-scope rows

**Files:**

- Modify: `src/core/reconciler.ts:89-107`
- Test: `src/core/__tests__/reconciler.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe("reconcile")` block:

```ts
it("skips a done issue only when every in-scope row's PR is merged; descoped rows are ignored", async () => {
  const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), makeTestConfig());
  const issueTracker = new MockIssueTracker();
  issueTracker.listByPhaseResults.set("testing", [makeIssue("PROJ-9", "testing")]);
  const store = new PipelineStateStore(db, ["api", "web"]);
  store.create("PROJ-9", "testing");
  store.setScope("PROJ-9", ["api", "web"]);
  store.updatePrNumber("PROJ-9", "api", 1, "main");
  store.updatePrNumber("PROJ-9", "web", 2, "main");
  store.markPrMerged("PROJ-9", "api", 1); // pending-others: not done yet

  let result = await reconcile({ issueTracker, queue, runtime, pipelineState: store, audit });
  expect(result.tasksCreated).toBe(1);

  queue.cancelPendingForIssue("PROJ-9", "test");
  store.setScope("PROJ-9", ["api"]); // web descoped, still holds PR #2
  store.updatePhase("PROJ-9", "testing");
  store.markDone("PROJ-9");
  db.prepare("UPDATE pipeline_state SET prior_phase = 'testing' WHERE issue_id = 'PROJ-9'").run();
  db.prepare(
    "UPDATE pipeline_repos SET pr_number = NULL WHERE issue_id = 'PROJ-9' AND repo = 'api'",
  ).run();

  result = await reconcile({ issueTracker, queue, runtime, pipelineState: store, audit });
  expect(result.skipped).toBe(1);
  expect(result.tasksCreated).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/__tests__/reconciler.test.ts`
Expected: the second reconcile creates a task because the mirror (first in-scope row `api`, PR null) already matches — confirm which assertion fails; if both pass, the descoped `web` row has leaked into the mirror and the implementation below is still required for the in-scope rule.

- [ ] **Step 3: Implement**

Replace lines 94–98 of `src/core/reconciler.ts` with:

```ts
      const inScopeRows = record?.repos.filter((row) => row.inScope) ?? [];
      if (
        record?.currentPhase === "done" &&
        inScopeRows.every((row) => row.prNumber === null) &&
        record.priorPhase === phase.name
      ) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/__tests__/reconciler.test.ts`
Expected: PASS.

- [ ] **Step 5: Check + commit**

```bash
npm run check
git add src/core/reconciler.ts src/core/__tests__/reconciler.test.ts
git commit -m "fix(reconciler): merge-replay skip considers every in-scope repo row"
```

---

### Task 5: `spec meta --repos`

**Files:**

- Modify: `src/cli/spec.ts:72-110`
- Modify: `src/cli/help.ts` (spec meta line)
- Test: `src/cli/__tests__/helpers.test.ts`

**Interfaces:**

- `redqueen spec meta <issueId> --open-questions N [--repos a,b]`. Workspace mode: `--repos` required, ≥ 1 name, every name in config → `pipelineState.setScope`. Legacy: ignored. Output `{ issueId, openQuestionCount, repos: PipelineRepoRecord[] }`.

- [ ] **Step 1: Write the failing tests**

In `src/cli/__tests__/helpers.test.ts` add a `describe("cmdSpec meta")`. The file's `beforeEach` writes a legacy mock config; for the workspace cases write a second config helper:

```ts
function writeWorkspaceConfig(): void {
  for (const name of ["api", "web"]) {
    execSync("git init -q", { cwd: tmp }); // root may be a repo; children must be
    mkdirSync(join(tmp, name), { recursive: true });
    execSync("git init -q", { cwd: join(tmp, name) });
  }
  writeFileSync(
    join(tmp, "redqueen.yaml"),
    [
      "issueTracker:",
      "  type: mock",
      "sourceControl:",
      "  type: mock",
      "project:",
      "  repos:",
      "    - { name: api, path: ./api, owner: o, repo: api, buildCommand: echo, testCommand: echo }",
      "    - { name: web, path: ./web, owner: o, repo: web, buildCommand: echo, testCommand: echo }",
      "",
    ].join("\n"),
  );
}

describe("cmdSpec meta", () => {
  it("legacy mode ignores --repos", async () => {
    await cmdPipeline(["update", "ISSUE-5", "--branch", "b"]);
    stdoutCapture = [];
    await cmdSpec(["meta", "ISSUE-5", "--open-questions", "0", "--repos", "whatever"]);
    const parsed = JSON.parse(stdoutCapture.join("")) as {
      openQuestionCount: number;
      repos: { repo: string }[];
    };
    expect(parsed.openQuestionCount).toBe(0);
    expect(parsed.repos.map((r) => r.repo)).toEqual(["default"]);
  });

  it("workspace mode requires --repos and records scope", async () => {
    writeWorkspaceConfig();
    await cmdPipeline(["update", "ISSUE-6", "--repo", "api", "--branch", "b"]);
    await expect(cmdSpec(["meta", "ISSUE-6", "--open-questions", "1"])).rejects.toThrow(
      /--repos is required/,
    );
    await expect(
      cmdSpec(["meta", "ISSUE-6", "--open-questions", "1", "--repos", "api,nope"]),
    ).rejects.toThrow(/unknown repo "nope".*api, web/);
    stdoutCapture = [];
    await cmdSpec(["meta", "ISSUE-6", "--open-questions", "1", "--repos", "web"]);
    const parsed = JSON.parse(stdoutCapture.join("")) as {
      repos: { repo: string; inScope: boolean }[];
    };
    expect(parsed.repos).toEqual([
      expect.objectContaining({ repo: "api", inScope: false }),
      expect.objectContaining({ repo: "web", inScope: true }),
    ]);
  });
});
```

(`mkdirSync` must be added to the file's `node:fs` import.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/__tests__/helpers.test.ts -t "cmdSpec meta"`
Expected: FAIL — unknown option `--repos`.

- [ ] **Step 3: Implement**

Replace `cmdSpecMeta` in `src/cli/spec.ts`:

```ts
function cmdSpecMeta(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      "open-questions": { type: "string" },
      repos: { type: "string" },
    },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("spec meta: <id> is required");
  }
  const raw = values["open-questions"];
  if (raw === undefined) {
    throw new CliError("spec meta: --open-questions <N> is required");
  }
  const count = Number.parseInt(raw, 10);
  if (Number.isNaN(count) || count < 0 || String(count) !== raw.trim()) {
    throw new CliError(`spec meta: --open-questions must be a non-negative integer, got "${raw}"`);
  }
  const ctx = loadCliContext();
  try {
    const existing = ctx.pipelineState.get(issueId);
    if (existing === null) {
      throw new CliError(`spec meta: no pipeline record for ${issueId} — run new-ticket first`);
    }
    ctx.pipelineState.setOpenQuestionCount(issueId, count);
    // Routing is spec-declared: the prompt-writer names the repos in scope and
    // every downstream skill loops over those rows. Legacy installs have one
    // repo and ignore the flag.
    if (ctx.config.project.workspaceMode) {
      const names = parseRepoList(values.repos, ctx);
      ctx.pipelineState.setScope(issueId, names);
    }
    const repos = ctx.pipelineState.listRepos(issueId);
    ctx.audit.log({
      component: "helper:spec",
      issueId,
      message: `Recorded open-question count: ${String(count)}${
        ctx.config.project.workspaceMode
          ? `; repos in scope: ${repos
              .filter((r) => r.inScope)
              .map((r) => r.repo)
              .join(", ")}`
          : ""
      }`,
      metadata: {
        openQuestionCount: count,
        repos: repos.map((r) => ({ repo: r.repo, inScope: r.inScope })),
      },
    });
    writeJson({ issueId, openQuestionCount: count, repos });
  } finally {
    ctx.cleanup();
  }
  return Promise.resolve();
}

function parseRepoList(raw: string | undefined, ctx: CliContext): string[] {
  const valid = ctx.config.project.repos.map((r) => r.name);
  if (raw === undefined || raw.trim() === "") {
    throw new CliError(
      `spec meta: --repos is required in workspace mode (valid: ${valid.join(", ")})`,
    );
  }
  const names = [
    ...new Set(
      raw
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n !== ""),
    ),
  ];
  if (names.length === 0) {
    throw new CliError(
      `spec meta: --repos must name at least one repo (valid: ${valid.join(", ")})`,
    );
  }
  for (const name of names) {
    if (valid.includes(name) === false) {
      throw new CliError(`spec meta: unknown repo "${name}" — valid: ${valid.join(", ")}`);
    }
  }
  return names;
}
```

Add `import type { CliContext } from "./context.js";`. Update `src/cli/help.ts`: `spec meta <id>              Record spec metadata (--open-questions <N> --repos a,b)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/__tests__/helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Check + commit**

```bash
npm run check
git add src/cli/spec.ts src/cli/help.ts src/cli/__tests__/helpers.test.ts
git commit -m "feat(cli): spec meta --repos records which repos a ticket touches"
```

---

### Task 6: `stack setup` per repo

**Files:**

- Modify: `src/cli/stack.ts`
- Modify: `src/cli/pipeline.ts` (`pipeline cleanup` per row)
- Modify: `src/cli/help.ts`
- Test: `src/cli/__tests__/stack.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export interface StackRepoSetup {
    repo: string;
    worktree: string;
    branch: string | null;
    merged: string[];
    prBase: string;
  }
  export type StackSetupOutput =
    | {
        status: "ok";
        repos: StackRepoSetup[];
        worktree: string;
        branch: string | null;
        merged: string[];
        prBase: string;
      } // top-level = repos[0]
    | { status: "blocked"; unsatisfied: string[]; problems: StackProblem[]; cycle: string[] | null }
    | {
        status: "conflict";
        repo: string;
        branch: string | null;
        files: string[];
        repos: StackRepoSetup[];
      }; // repos = completed before the conflict
  ```
- Repo set: `--spec` → every configured repo; coding → repos with an in-scope row (legacy: `[repos[0]]` when no rows yet). Per repo: cwd `repo.path`, `bareBase = bareBaseBranch(repo.baseBranch)`, worktree `worktreePathFor(config, issueId, repo.name, spec ? "spec" : "coding")`, merge refs from `resolution.repos[repo.name]`.

- [ ] **Step 1: Write the failing tests**

Append to `src/cli/__tests__/stack.test.ts` (fake-git describe):

```ts
it("workspace: assembles one worktree per in-scope repo with that repo's ancestors only", async () => {
  const h = mkStackHarness(tmp);
  const config = makeTestConfig({
    project: {
      directory: tmp,
      workspaceMode: true,
      repos: [
        {
          name: "api",
          path: join(tmp, "api"),
          owner: "o",
          repo: "api",
          baseBranch: "origin/main",
          buildCommand: "b",
          testCommand: "t",
          modules: [],
        },
        {
          name: "web",
          path: join(tmp, "web"),
          owner: "o",
          repo: "web",
          baseBranch: "origin/develop",
          buildCommand: "b",
          testCommand: "t",
          modules: [],
        },
      ],
    },
  });
  h.pipelineState.create("#2", "coding");
  h.pipelineState.setScope("#2", ["api", "web"]);
  // Blocker #1 at the gate touched api only.
  h.issueTracker.blockedBy.set("#2", [{ id: "#1", closed: false }]);
  h.issueTracker.phases.set("#1", "human-review");
  h.pipelineState.create("#1", "human-review");
  h.pipelineState.updateBranchInfo("#1", "api", { branchName: "feature/#1", prNumber: 5 });
  const git = fakeGit();
  const calls: { cmd: string; cwd: string }[] = [];
  const run: GitRun = (args, cwd) => {
    calls.push({ cmd: args.join(" "), cwd });
    return git.run(args, cwd);
  };

  const result = await executeStackSetup({ ...h.io, config, git: run });

  expect(result.status).toBe("ok");
  if (result.status !== "ok") {
    return;
  }
  expect(result.repos).toEqual([
    {
      repo: "api",
      worktree: join(tmp, ".redqueen", "worktrees", "#2", "api"),
      branch: "feature/#2",
      merged: ["origin/feature/#1"],
      prBase: "feature/#1",
    },
    {
      repo: "web",
      worktree: join(tmp, ".redqueen", "worktrees", "#2", "web"),
      branch: "feature/#2",
      merged: [],
      prBase: "develop",
    },
  ]);
  expect(result.worktree).toBe(result.repos[0]?.worktree);
  expect(calls.filter((c) => c.cmd.startsWith("fetch")).map((c) => c.cwd)).toEqual([
    join(tmp, "api"),
    join(tmp, "web"),
  ]);
  expect(calls.some((c) => c.cwd === tmp)).toBe(false);
  expect(h.pipelineState.getRepo("#2", "web")).toMatchObject({
    branchName: "feature/#2",
    worktreePath: join(tmp, ".redqueen", "worktrees", "#2", "web"),
  });
});

it("workspace --spec: every repo gets a detached exploration worktree", async () => {
  const h = mkStackHarness(tmp);
  const config = makeTestConfig({
    project: {
      directory: tmp,
      workspaceMode: true,
      repos: [
        {
          name: "api",
          path: join(tmp, "api"),
          owner: "o",
          repo: "api",
          baseBranch: "origin/main",
          buildCommand: "b",
          testCommand: "t",
          modules: [],
        },
        {
          name: "web",
          path: join(tmp, "web"),
          owner: "o",
          repo: "web",
          baseBranch: "origin/main",
          buildCommand: "b",
          testCommand: "t",
          modules: [],
        },
      ],
    },
  });
  const git = fakeGit();
  const result = await executeStackSetup({ ...h.io, spec: true, config, git: git.run });
  expect(result.status).toBe("ok");
  if (result.status !== "ok") {
    return;
  }
  expect(result.repos.map((r) => r.worktree)).toEqual([
    join(tmp, ".redqueen", "worktrees", "spec-#2", "api"),
    join(tmp, ".redqueen", "worktrees", "spec-#2", "web"),
  ]);
  expect(git.calls).toContain(
    `worktree add --detach ${join(tmp, ".redqueen", "worktrees", "spec-#2", "web")} origin/main`,
  );
});

it("workspace: a conflict names the repo and keeps the repos completed before it", async () => {
  const h = mkStackHarness(tmp);
  const config = makeTestConfig({
    project: {
      directory: tmp,
      workspaceMode: true,
      repos: [
        {
          name: "api",
          path: join(tmp, "api"),
          owner: "o",
          repo: "api",
          baseBranch: "origin/main",
          buildCommand: "b",
          testCommand: "t",
          modules: [],
        },
        {
          name: "web",
          path: join(tmp, "web"),
          owner: "o",
          repo: "web",
          baseBranch: "origin/main",
          buildCommand: "b",
          testCommand: "t",
          modules: [],
        },
      ],
    },
  });
  h.pipelineState.create("#2", "coding");
  h.pipelineState.setScope("#2", ["api", "web"]);
  h.issueTracker.blockedBy.set("#2", [{ id: "#1", closed: false }]);
  h.issueTracker.phases.set("#1", "human-review");
  h.pipelineState.create("#1", "human-review");
  h.pipelineState.updateBranchInfo("#1", "api", { branchName: "feature/#1", prNumber: 5 });
  h.pipelineState.updateBranchInfo("#1", "web", { branchName: "feature/#1", prNumber: 6 });
  let mergeCalls = 0;
  const git = fakeGit([
    [
      "merge --no-edit origin/feature/#1",
      () => {
        mergeCalls++;
        if (mergeCalls === 2) {
          throw new Error("conflict");
        }
        return "";
      },
    ],
    ["diff --name-only --diff-filter=U", "src/x.ts\n"],
  ]);

  const result = await executeStackSetup({ ...h.io, config, git: git.run });

  expect(result).toMatchObject({ status: "conflict", repo: "web", files: ["src/x.ts"] });
  if (result.status === "conflict") {
    expect(result.repos.map((r) => r.repo)).toEqual(["api"]);
  }
});
```

The existing legacy tests must keep passing unchanged (same git call sequences, `result.worktree/branch/merged/prBase` present).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/__tests__/stack.test.ts`
Expected: FAIL — `repos` missing on the result / wrong cwd.

- [ ] **Step 3: Implement**

Replace the types and `executeStackSetup` in `src/cli/stack.ts`:

```ts
import { bareBaseBranch, resolveStack, terminalGateNames } from "../core/stack.js";
import type { StackProblem, StackRepoResolution } from "../core/stack.js";
import { worktreePathFor } from "../core/worktree-layout.js";
import type { RepoConfig } from "../core/config.js";

export interface StackRepoSetup {
  repo: string;
  worktree: string;
  branch: string | null;
  merged: string[];
  prBase: string;
}

export type StackSetupOutput =
  | {
      status: "ok";
      repos: StackRepoSetup[];
      // Mirror of repos[0] for single-repo callers.
      worktree: string;
      branch: string | null;
      merged: string[];
      prBase: string;
    }
  | {
      status: "blocked";
      unsatisfied: string[];
      problems: StackProblem[];
      cycle: string[] | null;
    }
  | {
      status: "conflict";
      repo: string;
      branch: string | null;
      files: string[];
      repos: StackRepoSetup[];
    };

export async function executeStackSetup(io: StackSetupIo): Promise<StackSetupOutput> {
  const { issueId, spec, config, issueTracker, pipelineState, git } = io;
  const targets = config.project.repos.map((repo) => ({
    name: repo.name,
    bareBase: bareBaseBranch(repo.baseBranch),
  }));
  const primaryBase = targets[0]?.bareBase ?? bareBaseBranch(config.pipeline.baseBranch);

  const resolution = await resolveStack(issueId, primaryBase, {
    getBlockedBy: (id) => issueTracker.getBlockedBy(id),
    getPipelineRecord: (id) => pipelineState.get(id),
    getTrackerPhase: (id) => issueTracker.getPhase(id),
    terminalGates: terminalGateNames(buildPhaseGraph(config.phases)),
    repos: targets,
  });
  if (resolution.ok === false) {
    // Belt-and-braces — the orchestrator already gated before dispatch.
    return {
      status: "blocked",
      unsatisfied: resolution.unsatisfied,
      problems: resolution.problems,
      cycle: resolution.cycle,
    };
  }

  // --spec explores every repo (candidates are unknowable before reading code);
  // coding assembles the in-scope rows. Legacy installs have one repo and, on
  // a fresh coding pass, no rows yet.
  const record = pipelineState.get(issueId);
  const inScope = new Set((record?.repos ?? []).filter((r) => r.inScope).map((r) => r.repo));
  const repos = spec
    ? config.project.repos
    : config.project.repos.filter((r) => inScope.has(r.name));
  const selected = repos.length > 0 ? repos : config.project.repos.slice(0, 1);

  let branch: string | null = null;
  if (spec === false) {
    branch = record?.repos.find((r) => r.branchName !== null)?.branchName ?? null;
    if (branch === null) {
      const issueType = await issueTracker.getIssue(issueId).then(
        (issue) => issue.issueType,
        () => null,
      );
      branch = resolveBranchPrefix(config.pipeline.branchPrefixes, issueType) + issueId;
    }
  }

  const done: StackRepoSetup[] = [];
  for (const repo of selected) {
    const perRepo = resolution.repos[repo.name] ?? {
      mergeBranches: [],
      prBase: bareBaseBranch(repo.baseBranch),
    };
    const outcome = setupRepo({ issueId, spec, config, repo, branch, perRepo, pipelineState, git });
    if (outcome.status === "conflict") {
      return { status: "conflict", repo: repo.name, branch, files: outcome.files, repos: done };
    }
    done.push(outcome.setup);
  }
  const first = done[0];
  if (first === undefined) {
    throw new Error("stack setup: no repos selected");
  }
  return {
    status: "ok",
    repos: done,
    worktree: first.worktree,
    branch: first.branch,
    merged: first.merged,
    prBase: first.prBase,
  };
}

interface RepoSetupIo {
  issueId: string;
  spec: boolean;
  config: RedQueenConfig;
  repo: RepoConfig;
  branch: string | null;
  perRepo: StackRepoResolution;
  pipelineState: PipelineStateStore;
  git: GitRun;
}

// One repo's worktree: branch from that repo's base, merge the ancestors that
// exist in that repo (rows the blockers pushed there — ancestors that never
// touched it contribute nothing and are skipped, not errors). Git runs at the
// repo's own path.
function setupRepo(
  io: RepoSetupIo,
): { status: "ok"; setup: StackRepoSetup } | { status: "conflict"; files: string[] } {
  const { issueId, spec, config, repo, branch, perRepo, pipelineState, git } = io;
  const cwd = repo.path;
  const bareBase = bareBaseBranch(repo.baseBranch);
  const worktreePath = worktreePathFor(config, issueId, repo.name, spec ? "spec" : "coding");
  const reuse = existsSync(worktreePath);

  let remoteBranchExists = false;
  if (spec === false && branch !== null) {
    // refs/heads/ prefix, same as the webhook path: never let a branch name
    // parse as a git option.
    remoteBranchExists =
      git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], cwd).trim() !== "";
  }

  const fetchRefs = [
    ...new Set([
      bareBase,
      ...(remoteBranchExists && branch !== null ? [branch] : []),
      ...perRepo.mergeBranches,
    ]),
  ];
  // Explicit destination refspecs: opportunistic origin/<X> tracking updates
  // follow the clone's fetch config, which --single-branch narrows — without
  // a destination the origin/<X> refs below would never materialize there.
  // The + keeps force-pushed ancestor branches from failing the fetch.
  git(
    ["fetch", "origin", ...fetchRefs.map((r) => `+refs/heads/${r}:refs/remotes/origin/${r}`)],
    cwd,
  );

  if (spec) {
    if (reuse) {
      // Throwaway exploration worktree — make re-runs deterministic by
      // re-detaching onto the fresh base tip.
      git(["checkout", "--detach", `origin/${bareBase}`], worktreePath);
    } else {
      git(["worktree", "add", "--detach", worktreePath, `origin/${bareBase}`], cwd);
    }
  } else if (reuse === false && branch !== null) {
    if (branchExistsLocally(git, cwd, branch)) {
      git(["worktree", "add", worktreePath, branch], cwd);
    } else {
      git(["worktree", "add", "-b", branch, worktreePath, `origin/${bareBase}`], cwd);
    }
  }
  // Reuse (coding): the worktree already sits on the branch — no rebase, ever.

  const mergeRefs = spec
    ? perRepo.mergeBranches.map((b) => `origin/${b}`)
    : [
        // Own remote branch first: absorbs deterministic refreshes pushed by
        // the pr-merged handler while this worktree lagged behind.
        ...(remoteBranchExists && branch !== null ? [`origin/${branch}`] : []),
        // Base only when the PR targets base: while stacked on an unmerged
        // blocker, folding in newer base commits would pollute the PR diff.
        ...(reuse && perRepo.prBase === bareBase ? [`origin/${bareBase}`] : []),
        ...perRepo.mergeBranches.map((b) => `origin/${b}`),
      ];

  const merged: string[] = [];
  for (const ref of mergeRefs) {
    try {
      git(["merge", "--no-edit", ref], worktreePath);
      merged.push(ref);
    } catch (err) {
      const files = git(["diff", "--name-only", "--diff-filter=U"], worktreePath)
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f !== "");
      if (files.length === 0) {
        // No unmerged entries → the merge never reached a content conflict
        // (spawn failure, dirty tree, bad ref). Reporting it as a conflict
        // would hand the coder an empty file list and an unresolvable loop.
        throw err;
      }
      if (spec) {
        // Spec mode has no resolve-and-continue loop — abort so the
        // prompt-writer explores base plus cleanly merged ancestors.
        git(["merge", "--abort"], worktreePath);
      }
      // Coding mode leaves the conflict in place — the coder resolves it in
      // the worktree and re-runs stack setup until it exits 0.
      return { status: "conflict", files };
    }
  }

  if (spec === false && branch !== null) {
    if (pipelineState.get(issueId) === null) {
      pipelineState.create(issueId);
    }
    pipelineState.updateBranchInfo(issueId, repo.name, { branchName: branch, worktreePath });
  }

  return {
    status: "ok",
    setup: { repo: repo.name, worktree: worktreePath, branch, merged, prBase: perRepo.prBase },
  };
}
```

(Keep `branchExistsLocally`, `defaultGitRun`, and `cmdStack` as they are — `cmdStack` already serializes `result` to JSON and maps statuses to exit codes; the conflict JSON now carries `repo`.) Remove the plan-1 `primaryRepoName` import if nothing else in the file uses it.

`src/cli/pipeline.ts` `cmdPipelineCleanup`: loop rows instead of the mirror:

```ts
const record = ctx.pipelineState.get(issueId);
if (record === null) {
  throw new CliError(`pipeline cleanup: no pipeline record for ${issueId}`);
}
const branchDeleted: string[] = [];
for (const row of record.repos) {
  const cwd = gitCwdFor(ctx.config, row.repo);
  if (row.worktreePath !== null && existsSync(row.worktreePath)) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", row.worktreePath], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      removed.push(row.worktreePath);
    } catch (err) {
      ctx.audit.log({
        component: "helper:pipeline",
        issueId,
        message: `Worktree removal failed: ${err instanceof Error ? err.message : String(err)}`,
        metadata: { repo: row.repo, worktreePath: row.worktreePath },
      });
    }
  }
  const deleteBranch = values["keep-branch"] !== true && row.branchName !== null;
  if (deleteBranch && row.branchName !== null) {
    try {
      execFileSync("git", ["branch", "-D", row.branchName], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      branchDeleted.push(`${row.repo}:${row.branchName}`);
    } catch (err) {
      ctx.audit.log({
        component: "helper:pipeline",
        issueId,
        message: `Branch deletion failed for ${row.branchName}: ${err instanceof Error ? err.message : String(err)}`,
        metadata: { repo: row.repo, branchName: row.branchName },
      });
    }
  }
  ctx.pipelineState.updateBranchInfo(issueId, row.repo, {
    worktreePath: null,
    ...(deleteBranch ? { branchName: null } : {}),
  });
}
ctx.audit.log({
  component: "helper:pipeline",
  issueId,
  message: `Cleaned up pipeline state (worktrees cleared${branchDeleted.length > 0 ? ", branches deleted" : ""})`,
  metadata: { removed, branchDeleted },
});
writeJson({ ok: true, removed, branchDeleted }, values.pretty === true);
```

(`import { gitCwdFor } from "../core/worktree-layout.js";`. The existing helpers test asserts `parsed.ok === true` only; `branchDeleted` changes from `string | null` to `string[]` — update any test reading it.)

`src/cli/help.ts` stack line: `stack setup <issueId>       Assemble stacked worktrees (one per in-scope repo; --spec = detached exploration worktrees for every repo). Exit 2 = merge conflict (JSON names the repo), 3 = blocked.`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli`
Expected: PASS (legacy stack tests unchanged).

- [ ] **Step 5: Check + commit**

```bash
npm run check
git add src/cli/stack.ts src/cli/pipeline.ts src/cli/help.ts src/cli/__tests__
git commit -m "feat(cli): stack setup and pipeline cleanup act per repo at each repo's own path"
```

---

### Task 7: `redqueen status` lists repo rows

**Files:**

- Modify: `src/cli/status.ts`
- Test: `src/cli/__tests__/status.test.ts` (new)

**Interfaces:**

- `StatusPayload` gains `pipelines: PipelineStatusRow[]` where

  ```ts
  interface PipelineRepoStatus {
    repo: string;
    inScope: boolean;
    branchName: string | null;
    prNumber: number | null;
    orphaned: boolean;
  }
  interface PipelineStatusRow {
    issueId: string;
    currentPhase: string | null;
    repos: PipelineRepoStatus[];
  }
  ```

  `orphaned = inScope === false && prNumber !== null`. Read from SQLite (readonly) whenever the database exists — also while the orchestrator runs (WAL permits readers). Includes every record with at least one row, newest `updated_at` first, capped at 50.

- [ ] **Step 1: Write the failing test**

`src/cli/__tests__/status.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedQueenDatabase } from "../../core/database.js";
import { PipelineStateStore } from "../../core/pipeline-state.js";
import { cmdStatus } from "../status.js";

let tmp: string;
let originalCwd: string;
let out: string[];
let originalWrite: typeof process.stdout.write;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rq-status-"));
  originalCwd = process.cwd();
  writeFileSync(
    join(tmp, "redqueen.yaml"),
    "issueTracker:\n  type: mock\nsourceControl:\n  type: mock\nproject:\n  buildCommand: b\n  testCommand: t\n",
  );
  mkdirSync(join(tmp, ".redqueen"), { recursive: true });
  process.chdir(tmp);
  out = [];
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = originalWrite;
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("cmdStatus pipelines", () => {
  it("lists repo rows and flags orphaned PRs", async () => {
    const db = new RedQueenDatabase(join(tmp, ".redqueen", "redqueen.db"));
    const store = new PipelineStateStore(db.db, ["default"]);
    store.create("PROJ-1", "coding");
    store.setScope("PROJ-1", ["default", "old"]);
    store.updateBranchInfo("PROJ-1", "default", { branchName: "feature/PROJ-1", prNumber: 3 });
    store.updateBranchInfo("PROJ-1", "old", { branchName: "feature/PROJ-1", prNumber: 9 });
    store.setScope("PROJ-1", ["default"]);
    db.close();

    await cmdStatus(["--json"]);
    const payload = JSON.parse(out.join("")) as {
      pipelines: {
        issueId: string;
        repos: { repo: string; orphaned: boolean; inScope: boolean }[];
      }[];
    };
    expect(payload.pipelines).toEqual([
      {
        issueId: "PROJ-1",
        currentPhase: "coding",
        repos: [
          {
            repo: "default",
            inScope: true,
            branchName: "feature/PROJ-1",
            prNumber: 3,
            orphaned: false,
          },
          {
            repo: "old",
            inScope: false,
            branchName: "feature/PROJ-1",
            prNumber: 9,
            orphaned: true,
          },
        ],
      },
    ]);

    out = [];
    await cmdStatus([]);
    const text = out.join("");
    expect(text).toContain("PROJ-1");
    expect(text).toMatch(/old\s+feature\/PROJ-1\s+PR #9\s+ORPHANED/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/__tests__/status.test.ts`
Expected: FAIL — `pipelines` undefined.

- [ ] **Step 3: Implement**

In `src/cli/status.ts`:

```ts
interface PipelineRepoStatus {
  repo: string;
  inScope: boolean;
  branchName: string | null;
  prNumber: number | null;
  orphaned: boolean;
}

interface PipelineStatusRow {
  issueId: string;
  currentPhase: string | null;
  repos: PipelineRepoStatus[];
}
```

add `pipelines: PipelineStatusRow[];` to `StatusPayload`, `pipelines: []` to `emptyPayload`, and in `cmdStatus` after the payload is chosen:

```ts
if (existsSync(dbPath)) {
  payload.pipelines = readPipelines(
    dbPath,
    config.project.repos.map((r) => r.name),
  );
}
```

(`tryHttp`'s return type gains `pipelines: []` — it is filled from the DB above.) Add:

```ts
function readPipelines(dbPath: string, repoOrder: string[]): PipelineStatusRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const store = new PipelineStateStore(db, repoOrder);
    return store
      .listAll()
      .filter((record) => record.repos.length > 0)
      .slice(0, 50)
      .map((record) => ({
        issueId: record.issueId,
        currentPhase: record.currentPhase,
        repos: record.repos.map((row) => ({
          repo: row.repo,
          inScope: row.inScope,
          branchName: row.branchName,
          prNumber: row.prNumber,
          // A descoped row that still has a PR: nothing routes on it any more;
          // a human closes or merges it.
          orphaned: row.inScope === false && row.prNumber !== null,
        })),
      }));
  } finally {
    db.close();
  }
}
```

(`import { PipelineStateStore } from "../core/pipeline-state.js";` — `listAll` only reads, so the readonly handle is fine.) In `printHuman` append:

```ts
if (p.pipelines.length > 0) {
  process.stdout.write("  pipelines:\n");
  for (const pipeline of p.pipelines) {
    process.stdout.write(`    ${pipeline.issueId}  ${pipeline.currentPhase ?? "(no phase)"}\n`);
    for (const repo of pipeline.repos) {
      const branch = repo.branchName ?? "—";
      const pr = repo.prNumber === null ? "—" : `PR #${String(repo.prNumber)}`;
      const flag = repo.orphaned
        ? "  ORPHANED — descoped; close or merge manually"
        : repo.inScope === false
          ? "  (descoped)"
          : "";
      process.stdout.write(`      ${repo.repo.padEnd(12)} ${branch.padEnd(28)} ${pr}${flag}\n`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/__tests__/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Check + commit**

```bash
npm run check
git add src/cli/status.ts src/cli/__tests__/status.test.ts
git commit -m "feat(status): show every repo row per ticket and flag orphaned PRs"
```

---

### Task 8: End-to-end two-repo workspace loop

**Files:**

- Modify: `src/__tests__/e2e/full-loop.test.ts`

**Interfaces:**

- Consumes everything above: registry with two `InMemorySourceControl` instances, `PipelineStateStore(db, ["api", "web"])`, `setScope`, per-row `updateBranchInfo`, poll-driven `reconcileMergedPrs`.

- [ ] **Step 1: Write the failing test**

Add a second `it` inside the existing describe (reuse `waitFor`, `writeSkill`, `createFakeWorkerRunner`, `phaseRule`, the `beforeEach` temp dir). Both repo directories must be git repos so merge cleanup's `git branch -D` fails softly rather than erroring on a non-repo cwd:

```ts
it("workspace mode: a two-repo ticket opens two PRs and finishes only after both merge", async () => {
  const apiDir = join(tempDir, "api");
  const webDir = join(tempDir, "web");
  for (const dir of [apiDir, webDir]) {
    mkdirSync(dir, { recursive: true });
    execSync("git init -q", { cwd: dir });
  }
  const repos = [
    {
      name: "api",
      path: apiDir,
      owner: "acme",
      repo: "Api",
      baseBranch: "origin/main",
      buildCommand: "b",
      testCommand: "t",
      modules: [],
    },
    {
      name: "web",
      path: webDir,
      owner: "acme",
      repo: "Web",
      baseBranch: "origin/main",
      buildCommand: "b",
      testCommand: "t",
      modules: [],
    },
  ];
  const seededIssue = makeIssue({
    id: "TEST-2",
    summary: "Add email type",
    phase: "spec-writing",
    assignee: "ai-user",
    issueType: "feature",
  });
  const issueTracker = new InMemoryIssueTracker({ issues: [seededIssue] });
  const apiSc = new InMemorySourceControl();
  const webSc = new InMemorySourceControl();
  const sourceControls = createSourceControlRegistry([
    { name: "api", fullName: "acme/Api", adapter: apiSc },
    { name: "web", fullName: "acme/Web", adapter: webSc },
  ]);

  const db = new RedQueenDatabase(dbPath);
  const queue = new SqliteTaskQueue(db.db);
  const pipelineState = new PipelineStateStore(db.db, ["api", "web"]);
  const phaseUsage = new PhaseUsageStore(db.db);
  const orchestratorState = new OrchestratorStateStore(db.db);
  const audit = new DualWriteAuditLogger(db.db, auditPath);

  const workerCalls: string[] = [];
  const workerRunner = createFakeWorkerRunner([
    (call) => {
      workerCalls.push(call.phaseName);
      return null;
    },
    (call) => {
      if (call.phaseName !== "spec-writing") {
        return null;
      }
      expect(call.promptBody).toContain("repos:");
      void issueTracker.setSpec("TEST-2", "## Spec\n## Repos in Scope\n- api\n- web\n");
      pipelineState.setScope("TEST-2", ["api", "web"]); // what `redqueen spec meta --repos api,web` does
      return {
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "Spec drafted",
        error: null,
        usage: null,
        reportedCostUsd: null,
      };
    },
    (call) => {
      if (call.phaseName !== "coding") {
        return null;
      }
      expect(call.promptBody).toMatch(/name: api[\s\S]*inScope: true/);
      for (const [name, sc] of [
        ["api", apiSc],
        ["web", webSc],
      ] as const) {
        const branchName = "feature/TEST-2";
        sc.branches.add(branchName);
        void sc.createPullRequest({
          title: "TEST-2",
          body: "",
          head: branchName,
          base: "main",
          draft: false,
        });
        pipelineState.updateBranchInfo("TEST-2", name, {
          branchName,
          prNumber: 1,
          prBaseBranch: "main",
        });
      }
      return {
        success: true,
        exitCode: 0,
        elapsed: 1,
        summary: "Two PRs",
        error: null,
        usage: null,
        reportedCostUsd: null,
      };
    },
    phaseRule("code-review", "Review approved"),
    phaseRule("testing", "Tests pass"),
  ]);

  const config = buildConfig({
    project: { directory: tempDir, repos, workspaceMode: true },
  });
  const runtime = new RuntimeState(buildPhaseGraph(DEFAULT_PHASES), config);
  const rq = new RedQueen({
    runtime,
    queue,
    pipelineState,
    phaseUsage,
    orchestratorState,
    audit,
    issueTracker,
    sourceControls,
    workerRunner,
    installSignalHandlers: false,
    sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
  });
  const startPromise = rq.start();
  try {
    await waitFor(() => issueTracker.phases.get("TEST-2") === "spec-review", "spec-review");
    await issueTracker.setPhase("TEST-2", "coding");
    await waitFor(() => issueTracker.phases.get("TEST-2") === "human-review", "human-review");
    expect(apiSc.prs.size).toBe(1);
    expect(webSc.prs.size).toBe(1);

    await apiSc.mergePullRequest(1);
    await waitFor(
      () => pipelineState.getRepo("TEST-2", "api")?.prNumber === null,
      "api row merged",
    );
    expect(pipelineState.get("TEST-2")?.currentPhase).toBe("human-review");
    expect(pipelineState.getRepo("TEST-2", "web")?.prNumber).toBe(1);

    await webSc.mergePullRequest(1);
    await waitFor(() => pipelineState.get("TEST-2")?.currentPhase === "done", "pipeline done");
  } finally {
    await rq.stop();
    await startPromise.catch(() => undefined);
  }
  try {
    expect(workerCalls).toEqual(["spec-writing", "coding", "code-review", "testing"]);
    expect(pipelineState.get("TEST-2")?.repos.map((r) => [r.repo, r.terminalPrNumber])).toEqual([
      ["api", 1],
      ["web", 1],
    ]);
  } finally {
    db.close();
  }
}, 30_000);
```

`buildConfig` must accept a partial `project` override: change its signature to `buildConfig(overrides: { project?: Partial<RedQueenConfig["project"]> } & Omit<Partial<RedQueenConfig>, "project"> = {})` and merge `project: { ...base.project, ...(overrides.project ?? {}) }`. Add `execSync` (`node:child_process`) and `createSourceControlRegistry` imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/e2e`
Expected: FAIL only if any per-row path above is missing; with Tasks 1–7 in place it should pass on the first run — if it does, temporarily break `markPrMerged`'s "remaining" check to confirm the test detects premature `done`, then restore it.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Check + commit**

```bash
npm run check
git add src/__tests__/e2e/full-loop.test.ts
git commit -m "test(e2e): two-repo workspace ticket completes only after both PRs merge"
git push
```

---

## Plan-level verification

- [ ] `npm run check` and `npx vitest run` clean.
- [ ] Legacy smoke unchanged from plan 1.
- [ ] Workspace smoke on a scratch install with two `git init`-ed sibling repos: `redqueen spec meta X --open-questions 0 --repos a` sets scope; `redqueen stack setup X --spec` creates `.redqueen/worktrees/spec-X/a` and `.../spec-X/b`; `redqueen status` shows both rows.

## Self-review notes

- §3: rework `hasPr` (Task 1), stack gate (Task 2), `dismissStaleReviews` per row (plan 1). §4: layout + git cwd rule (Task 3, Task 6). §7: `spec meta --repos` (5), `--repo` (plan 1), `pr create` per-repo base (2), `stack setup` (6), blocker gate (2), `status` (7). §8: webhook `repo`, `any()` validation, `byFullName` routing, unknown drop, per-repo retarget, per-row scan, per-row cleanup at `repo.path`, reconciler skip (4), refresh worktree layout (3). Error handling bullets: unknown `--repo` (plan 1), unknown full name (3), `spec meta` name (5), empty scope → coder rule is plan 3.
- Type consistency: `StackResolution.repos: Record<string, StackRepoResolution>`; `StackResolveDeps.repos?: StackRepoTarget[]`; `worktreePathFor(config, issueId, repoName, kind)`; `gitCwdFor(config, repoName)`; `cleanupLocalBranchArtifacts(issueId, repo, ...)`; `refreshDependentBranch(issueId, repo, ...)`; `markPrMerged` returns `"pending-others"` on non-final rows.
