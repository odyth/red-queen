# Red Queen v6 — Phase 2: Multi-phase Prompt-writer (Research → Design → Write)

> Standalone execution plan. No need to read `redqueen-v6.md` to execute this — every load-bearing decision is re-encoded here.

## 1. Executive Summary

Replace the single `spec-writing` phase (which today dispatches the `prompt-writer` skill in both fresh-write and rework modes) with a three-phase pipeline:

1. **`spec-research`** — `spec-researcher` skill explores the codebase and writes structured findings.
2. **`spec-design`** — `spec-designer` skill sketches the approach and lists open questions.
3. **`spec-writing`** — `spec-writer` skill writes (or refines) the actual spec.

Phase outputs flow through the existing `phase_sub_iterations` SQLite table (added in v6 phase 1). No tracker-side noise.

Alongside the skill changes, this phase also:

- Removes `spec-feedback` entirely (its work folds into `spec-writing` via iteration branching).
- Re-points `spec-review.rework` from `spec-feedback` to `spec-writing`.
- Adds a five-case branching matrix to the writer to handle fresh / refine / noop / restart on rework rounds. The detection signal `humanModifiedSpec` is pre-computed by the orchestrator (no shell hashing in the skill).
- Surfaces open-question count via `redqueen spec meta --open-questions N` (declared) plus a server-side parsed count from `redqueen spec set` (audit/safety net). Orchestrator routes on `max(declared, parsed)`.
- Wires up `feedback_iterations` (previously dead code) as the cap on spec-rework rounds, with new reset semantics that differentiate gate-advance from gate-rework.
- Adds a generic `redqueen pipeline get` CLI so external tooling can read pipeline_state metadata. (The writer skill does NOT need this for case detection — see Decision 3.)

After this phase the spec pipeline runs end-to-end without `spec-feedback` and without `plan-review`. The redesign's later phases (inline review threads, rework-aware coder, testing PR comments, final-test carve-out, dashboard sub-iter rendering) are explicitly **out of scope** here.

## 2. Context & Background

### What exists today

- **`spec-writing` phase** dispatches the `prompt-writer` skill (`src/skills/prompt-writer/SKILL.md`). The skill branches internally on `phaseName === "spec-writing"` (fresh) vs `phaseName === "spec-feedback"` (revision).
- **`spec-feedback` phase** also dispatches `prompt-writer`. It exists to handle rework after a human kicks back from `spec-review`.
- **`phase_sub_iterations` table + `redqueen sub-iter start|complete` CLI** were added in v6 phase 1 as scaffolding. They currently only have `start` and `complete` — no `latest`, no stdin support.
- **`incrementFeedbackIterations` exists on `PipelineStateStore`** but is NOT called from `orchestrator.ts` anywhere (only tests reference it). The counter is dead code today.
- **`skill-context.ts:92-100` (`relevantIterationCount`)** uses brittle string matching: `phaseName.includes("feedback")` → returns `feedbackIterations`, `phaseName.includes("review")` → returns `reviewIterations`. Adding a phase named `spec-writing` won't pick up the feedback counter.
- **`processTask` (orchestrator.ts:297-315)** blindly resets ALL iteration counters whenever the issue's `currentPhase` was a human-gate. This means any gate-leave (advance OR rework) zeroes both `review_iterations` and `feedback_iterations`.
- **`config.pipeline.skipSpecReviewIfReady`** exists in the Zod schema and parses, but the only consumer was the removed `plan-review` phase. There's an audit-log warning that the knob is currently a no-op (config.ts:323-325).
- **`pipeline_state` columns:** `issue_id, current_phase, branch_name, pr_number, worktree_path, review_iterations, feedback_iterations, spec_content, prior_context, delegator_account_id, created_at, updated_at`. The `plan_review_*` columns were dropped in phase 1.
- **Spec storage:** `redqueen spec set <issueId>` writes the spec to the tracker (custom field for Jira) and caches in `pipeline_state.spec_content`. Read via `redqueen spec get`.
- **Skill dispatch lifecycle:** `orchestrator.dispatchWorkerForTask` builds the YAML context, writes the rendered prompt to a temp file, spawns the Claude worker process, parses the JSON result, and routes via `handleSuccess` / `handleFailure`.

### What's broken

- **Feedback loop has no durable feedback signal.** When `spec-feedback` fires today, the only feedback the skill sees is the prior worker's truncated `priorContext` summary. Specific reviewer concerns, blockers, or comments don't make it from one phase to the next as structured data.
- **No way to detect noop rework rounds.** If the human kicks back without making edits or comments, the skill grinds out a new spec from scratch each time, indistinguishable from the prior round.
- **Iteration counter semantics are internally inconsistent.** `feedback_iterations` is supposed to cap the rework loop at 3 attempts, but the gate-leave reset zeroes it on every kick-back. The cap can never fire.
- **`prompt-writer` skill mixes two flows in one file** — fresh-write and revision — adding noise to every dispatch's context window. Three sub-phases would compound this; one file becomes five flows.

### Phase 1 already shipped

- Plan-review phase + skill + CLI + `plan_review_*` columns removed.
- `phase_sub_iterations` table + `sub-iter start|complete` CLI added.
- `review_iterations` resets to 0 on `code-review` pass (Alice parity).
- Truncation cap raised from 500 → 2000 chars (`SUMMARY_MAX_LEN`, `ERROR_MAX_LEN` in `worker.ts`).

You can use the sub-iter scaffolding directly.

## 3. Goals and Non-Goals

### Goals

- Split spec generation into three explicit sub-phases. Each dispatch is its own worker process and context window.
- Phase outputs flow through `phase_sub_iterations.summary` (extended to support multi-KB stdin input).
- Spec-writer correctly handles five cases on rework: fresh / refine-comments / refine-edits / noop / restart-empty, plus the rare iter-0-with-content edge.
- Case detection in the writer uses pre-computed signals from the YAML context — no shell hashing.
- Open-question count drives orchestrator routing: `0 && skipSpecReviewIfReady` → coding; else → gate.
- `feedback_iterations` correctly caps spec-rework loops at 3 attempts before escalating to `blocked`.
- `redqueen spec set` becomes the authoritative source of the parsed open-question count.
- Skills are isolated, focused, debuggable. Each has a single purpose.
- `npm run check` and the existing test suite stay green; new tests cover the five-case matrix and the cap behavior.

### Non-Goals

- Inline PR review threads (v6 Phase 3).
- Coder branching on `priorPhase` for rework feedback source selection (v6 Phase 4).
- Testing publishing structured PR comments (v6 Phase 4).
- `review_exhausted` flag + `code-review.escalateTo: testing` (v6 Phase 5).
- Dashboard rendering of sub-iteration labels (v6 Phase 6).
- Pre-generated global codebase map at `redqueen init`.
- Per-issue codebase notes in the repo.
- Explicit `spec-restart` CLI/phase (the empty-spec auto-restart in Case 5 covers this).
- Server-side regex sniff for `TBD` / `FIXME` markers outside the `## Open Questions` section. Prompt calibration is the sole defense; revisit if real runs show drift.

## 4. Design Decisions & Key Details

### Decision 1 — Three skill files, not one branching file

**Decision:** Add three new skills at `src/skills/spec-researcher/`, `src/skills/spec-designer/`, `src/skills/spec-writer/`. Each has its own `SKILL.md`. Delete `src/skills/prompt-writer/` entirely.

**Rationale:** The skill markdown is read by the model on every dispatch. A combined file would force the writer to read research and design instructions on every fresh-write or refine call — pure token waste plus attention dilution. The three contracts are intentionally different (research does not propose, design does not write, writer consumes both); separate files make this contract enforceable. Each file can also be independently disabled via `config.skills.disabled`.

**Cost:** ~40 lines of duplicated boilerplate per file (YAML context reading, attachment fetch, blocked path). Acceptable.

### Decision 2 — Phase contracts

| Skill              | Inputs                                                                                  | Outputs                                                                | Forbidden                                          |
|--------------------|-----------------------------------------------------------------------------------------|------------------------------------------------------------------------|----------------------------------------------------|
| `spec-researcher`  | YAML context, ticket, attachments, codebase map, worktree                                | Sub-iter "Codebase research" summary                                   | Propose changes, name a design, write spec content |
| `spec-designer`    | YAML context, ticket, attachments, research findings                                     | Sub-iter "Solution design" summary                                     | Write the spec, run build/test, modify code        |
| `spec-writer`      | YAML context (including `humanModifiedSpec`, `lastAiSpecAt`), ticket, attachments, research + design findings | Spec via `redqueen spec set`, open-question count via `redqueen spec meta`, sub-iter "Writing spec" summary, sometimes phase transitions | Re-derive research/design wholesale; compute hashes in shell |

Full prompt text in Section 9.

### Decision 3 — Spec-writer five-case branching matrix

The writer no longer hashes specContent in shell. The orchestrator pre-computes `humanModifiedSpec: boolean` and injects it via the YAML context (Decision 17). The writer reads two signals from YAML and computes one signal locally:

```
spec_empty        = specContent is null OR trim(specContent) is empty   (from YAML)
humanModifiedSpec = true if current spec_content differs from last AI write   (from YAML, pre-computed)
new_comments      = comments where createdAt > lastAiSpecAt AND author != AI account   (computed locally from `redqueen issue comments`)
```

| Case | `iterationCount` | `spec_empty` | `humanModifiedSpec` | new comments | Action                                              |
|------|-----------------:|--------------|---------------------|--------------|-----------------------------------------------------|
| 1    | 0                | true         | n/a                 | n/a          | Fresh write                                         |
| 2    | ≥1               | false        | false               | yes (≥1)     | Refine (fold new comments)                          |
| 3    | any              | false        | true                | n/a          | Refine (fold inline edits + new comments if any)    |
| 4    | ≥1               | false        | false               | no (0)       | Noop — return to gate without rewriting             |
| 5    | ≥1               | true         | n/a                 | n/a          | Restart — route back through `spec-research`        |

Case 3 deliberately accepts `iterationCount` of any value. This covers two real situations:

- **Iter ≥1 + human inline-edited the spec.** AI wrote v1; human kicked back through `spec-review` after editing the spec body directly on the tracker. `last_ai_spec_hash` is populated, current `specContent` hash differs → `humanModifiedSpec=true`.
- **Iter = 0 + human pre-populated the spec.** Ticket arrives with `specContent` already non-null and `last_ai_spec_hash` is null. The orchestrator computes "current ≠ null = different from null = different" → `humanModifiedSpec=true`. The writer folds the human content like an inline edit.

The writer detects exactly one case at the top and follows the corresponding flow. See the writer skill's prompt for the precise CLI sequences per case.

### Decision 4 — Empty-spec rewrite path (Case 5)

When the human deletes the spec body and routes back through the gate, the writer detects `spec_empty === true && iterationCount >= 1` and calls:

```
redqueen issue set-phase <issueId> spec-research
```

then exits 0.

The orchestrator's existing `respectAgentPhaseChange` path picks this up: it sees the issue's current phase no longer matches the phase that just ran, updates pipeline_state, and re-queues `spec-research`. The triple re-traverses (research → design → writing) and the writer falls into Case 1 (fresh write) on the inner spec-writing call because `specContent` is empty.

`feedback_iterations` is NOT reset by this transition — the gate-leave reset (which would zero it) does not fire here because we are not actually leaving a human gate. The restart costs one rework iteration.

### Decision 5 — Noop detection (Case 4)

When the rework path fires but the writer can find no human-driven changes:

1. Post a tracker comment: `"No changes requested since the last revision — returning to spec review without changes."`
2. `redqueen issue set-phase <issueId> spec-review`
3. Complete the sub-iter with a "Noop" summary.
4. Exit 0.

Do NOT touch the spec content, do NOT call `spec meta`, do NOT clean up the spec worktree.

Detection signals:
- `humanModifiedSpec === false` (the spec body is byte-identical to what the AI last wrote, after normalization, as pre-computed by the orchestrator).
- AND no human comments newer than `lastAiSpecAt` from a non-AI author.

False-positive risk: if a human edited the spec with only trailing-whitespace-equivalent changes, the noop fires. Acceptable — the human can re-edit with substantive changes or post a comment to force a real revision.

### Decision 6 — Open-question count via layered validation

**Locked decision from v6:** the skill calls `redqueen spec meta <issueId> --open-questions N` after writing the spec. This is the canonical declared count and goes into `pipeline_state.open_question_count`.

**Audit/safety layer added here:** `redqueen spec set <issueId>` ALSO parses the spec body's `## Open Questions` section, counts `- [ ]` items (unchecked), and stores `parsed_open_question_count` in pipeline_state.

The orchestrator routes on `max(declared, parsed)`:

- If both agree → use the value, route accordingly.
- If they differ → audit-log a warning, use the higher value (safer default = gate, never auto-skip when there's ambiguity).

The skill prompt explicitly tells the model: any `TBD`, `FIXME`, `?` placeholder, `<placeholder>`, or unresolved hedge anywhere in the spec body counts as an open question and must be moved into the Open Questions section before submission. The model is on the hook for moving them; the server-side parse only sees what's in the Open Questions section, so misplaced markers would not be caught by the parser.

**Server-side sniff for misplaced markers is explicitly NOT added in this phase.** Prompt calibration is the sole defense. If real runs show drift, the column structure supports adding the sniff later (parse the body outside the Open Questions section, bump `parsed_open_question_count` by match count) — it's purely additive.

### Decision 7 — Sub-iteration table as artifact channel

Reuse `phase_sub_iterations.summary` as the comms channel between phases. No new artifact table. No new TEXT columns on `pipeline_state` for findings or design.

CLI additions for this phase:

- `redqueen sub-iter complete <issueId> --summary-stdin` — read summary from stdin (so research/design output can be multi-KB without bumping argv length limits).
- `redqueen sub-iter latest <issueId> --phase <name>` — return the most recent COMPLETED sub-iteration for that phase as JSON. Empty result if none. Used by designer to read research and by writer to read both.

The dashboard already reads this table; phase comms is a free dual-purpose, not a conflict.

### Decision 8 — Phase graph delta

```diff
- spec-feedback                  (entire phase deleted)
+ spec-research                  (skill: spec-researcher, type: automated)
+ spec-design                    (skill: spec-designer, type: automated)
~ spec-writing.skill             prompt-writer       → spec-writer
+ spec-writing.maxIterations     undefined           → 3
+ spec-writing.escalateTo        undefined           → blocked
+ spec-writing.iterationCounter  (new field)         → "feedback"
~ spec-review.rework             spec-feedback       → spec-writing
~ spec-awaiting-info.next        spec-writing        → spec-research
```

Full updated `DEFAULT_PHASES` (relevant slice):

```
[
  { name: "spec-research", label: "Spec Research", type: "automated",
    skill: "spec-researcher", next: "spec-design",
    onFail: "spec-awaiting-info", assignTo: "ai" },
  { name: "spec-design", label: "Spec Design", type: "automated",
    skill: "spec-designer", next: "spec-writing",
    onFail: "spec-awaiting-info", assignTo: "ai" },
  { name: "spec-writing", label: "Spec Writing", type: "automated",
    skill: "spec-writer", next: "spec-review",
    onFail: "spec-awaiting-info",
    maxIterations: 3, escalateTo: "blocked",
    iterationCounter: "feedback",
    assignTo: "ai" },
  { name: "spec-review", label: "Spec Review", type: "human-gate",
    next: "coding", rework: "spec-writing", assignTo: "human" },
  { name: "spec-awaiting-info", label: "Awaiting Info", type: "human-gate",
    next: "spec-research", assignTo: "human" },
  ...
]
```

Rationale for `spec-awaiting-info.next → spec-research`: the human just answered a clarifying question. Re-running research lets the new info inform discovery rather than expecting the writer to fold it in alone. The cost is one extra research+design dispatch; the benefit is correctness when the human's answer changes scope.

Entry phase becomes `spec-research`. New tickets start there (the orchestrator already uses `getAllPhases()[0]` for the entry phase; ordering in `DEFAULT_PHASES` matters — put `spec-research` first).

### Decision 9 — Iteration counter reset semantics (pushback on v6 reset rule)

**The v6.md design doc has an internal inconsistency.** It states both:

- "All iteration counters reset to 0 when the issue leaves a human gate" (decision 16 / mechanism B).
- "The orchestrator increments `feedback_iterations` on each rework dispatch (capped by maxIterations, default 3)" (mechanism A).

These are mutually exclusive. If reset always fires on gate-leave, feedback_iterations never accumulates and the cap never triggers.

**Resolution adopted by this phase:**

| Gate-leave path                        | `review_iterations`                          | `feedback_iterations`                                  |
|----------------------------------------|----------------------------------------------|--------------------------------------------------------|
| Via `.next` (advance)                  | Reset to 0                                   | Reset to 0                                             |
| Via `.rework` (kick back)              | Reset to 0                                   | Increment by 1; if > target's maxIterations, route to escalateTo |
| Via other (e.g. `blocked.next`)        | Reset to 0                                   | Reset to 0                                             |

This means moving the blanket `pipelineState.resetIterations(issueId)` call OUT of the top of `orchestrator.processTask` (currently at lines 302-315) and INTO the two specific transition paths:

- **Advance via `.next`:** the existing `advanceNormal` path. Reset both counters here when the prior phase was a human gate.
- **Rework via `.rework`:** the existing `tryAutoTransitionRework` path. Reset `review_iterations` only, increment `feedback_iterations`, check against `maxIterations` of the rework target, route to `escalateTo` if exceeded.
- **Other gate-leaves** (when neither advance nor rework matched, e.g. agent set phase manually to bypass gate, blocked unblocked): keep the existing "reset both" behavior.

This is the most subtle architectural change in the phase. See implementation step 8 for the precise call-site changes.

### Decision 10 — Replace string-pattern iteration counter selection

Today `skill-context.ts:92-100` (`relevantIterationCount`) string-matches phase names to choose which counter to inject into YAML context as `iterationCount`. With `spec-writing` now needing `feedback_iterations` (not `review_iterations`, despite "review" appearing nowhere in the name), the string match would return 0 for spec-writing.

Add a new field to `PhaseDefinition`:

```typescript
type IterationCounterKind = "review" | "feedback" | "none";

interface PhaseDefinition {
  // ... existing fields
  iterationCounter?: IterationCounterKind;  // default "none"
}
```

Replace `relevantIterationCount` with:

```typescript
function relevantIterationCount(phase: PhaseDefinition, record: PipelineRecord): number {
  switch (phase.iterationCounter) {
    case "review": return record.reviewIterations;
    case "feedback": return record.feedbackIterations;
    case "none":
    case undefined: return 0;
  }
}
```

Update DEFAULT_PHASES:

- `spec-writing.iterationCounter`: `"feedback"`
- `code-review.iterationCounter`: `"review"`
- `code-feedback.iterationCounter`: `"feedback"` (already incremented as a side effect of the rework path under the new semantics)
- All others: omit (default `"none"`)

The Zod schema for `PhaseDefinitionSchema` in `config.ts` needs the new field too.

### Decision 11 — New CLIs

- **`redqueen pipeline get <issueId>`** — returns the full `pipeline_state` row as JSON. Generic; future tooling and external observability route through here instead of growing ad-hoc commands. Lives in `src/cli/pipeline.ts` (already exists; add a `get` subcommand alongside any existing ones). The spec-writer skill does NOT depend on this CLI for case detection — the orchestrator pre-computes `humanModifiedSpec` and injects it into the YAML context (Decision 17).

  Output shape (camelCase, matching `PipelineRecord`):
  ```json
  {
    "issueId": "PROJ-123",
    "currentPhase": "spec-writing",
    "branchName": null,
    "prNumber": null,
    "worktreePath": null,
    "reviewIterations": 0,
    "feedbackIterations": 1,
    "specContent": "# ...",
    "priorContext": "...",
    "delegatorAccountId": null,
    "openQuestionCount": null,
    "parsedOpenQuestionCount": null,
    "lastAiSpecHash": "abc123...",
    "lastAiSpecAt": "2026-05-19T12:34:56Z",
    "createdAt": "...",
    "updatedAt": "..."
  }
  ```

- **`redqueen spec meta <issueId> --open-questions N [--files-affected N]`** — writes declared metadata. Lives in `src/cli/spec.ts` as a new subcommand. Stores in `pipeline_state.open_question_count`. `--files-affected` is accepted but not consumed by routing this phase; record it for future use.

- **`redqueen sub-iter complete <issueId> --summary-stdin`** — extend `src/cli/sub-iter.ts`. When `--summary-stdin` is passed, read summary from stdin instead of requiring `--summary "..."`. Either form is accepted (one of them must be present).

- **`redqueen sub-iter latest <issueId> --phase <name>`** — new subcommand in `src/cli/sub-iter.ts`. Returns the most recent COMPLETED sub-iteration matching the filter, as JSON. If none exists, write `null` to stdout and exit 0. SQL: `SELECT * FROM phase_sub_iterations WHERE issue_id = ? AND phase_name = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1`.

### Decision 12 — Pipeline_state schema additions

Add four columns. All nullable. None reset by `resetIterations()`.

```sql
ALTER TABLE pipeline_state ADD COLUMN open_question_count INTEGER;
ALTER TABLE pipeline_state ADD COLUMN parsed_open_question_count INTEGER;
ALTER TABLE pipeline_state ADD COLUMN last_ai_spec_hash TEXT;
ALTER TABLE pipeline_state ADD COLUMN last_ai_spec_at TEXT;
```

Update `PipelineRow`, `PipelineRecord`, `toPipelineRecord`, and `PipelineStateStore` accordingly.

Setters needed:
- `setOpenQuestionCount(issueId, count: number | null)` — for `spec meta`.
- `setParsedOpenQuestionCount(issueId, count: number | null)` — for `spec set`.
- `setLastAiSpec(issueId, hash: string, at: string)` — for `spec set` after a successful write. (Note: NOT called by the noop path.)

Migration: add to the existing `runMigrations` method in `database.ts`. Use the duplicate-column-error swallow pattern already in use there.

### Decision 13 — Spec worktree lifecycle

Three skills, one worktree at `${projectDir}/.redqueen/worktrees/spec-${issueId}`.

- **Researcher** creates it (or refreshes if it already exists from a prior dispatch).
- **Designer** may refresh it if it needs to verify a design assumption against code. Most runs won't touch it.
- **Writer** refreshes (or recreates) on Cases 1, 2, 3. Removes on successful completion of Cases 1, 2, 3.
- **Noop (Case 4)** does NOT touch the worktree.
- **Restart (Case 5)** does NOT touch the worktree (the next research pass will refresh it).

Idempotent refresh pattern (same in all three skills):

```bash
bare_base=$(echo "${baseBranch}" | sed 's|^origin/||')
worktree="${projectDir}/.redqueen/worktrees/spec-${issueId}"
git fetch origin "${bare_base}"
if [ -d "${worktree}" ]; then
  git -C "${worktree}" fetch origin "${bare_base}"
  git -C "${worktree}" reset --hard "${baseBranch}"
else
  git worktree add "${worktree}" "${baseBranch}"
fi
```

Cleanup on writer success:

```bash
git worktree remove "${worktree}" \
  || git worktree remove --force "${worktree}" \
  || true
```

This worktree is distinct from the coder's worktree (`.redqueen/worktrees/${issueId}`) — they can coexist.

### Decision 14 — Stale sub-iteration sweep on start

When research crashes mid-iter, its sub-iter entry stays `in-progress` forever (no `completeLatestOpen` ever fires because the worker died). The next `sub-iter start` on the same issue creates a new entry; the dashboard now sees two open entries until the next phase completes.

Mitigation: in `SubIterationStore.start()`, before inserting, mark any older `in-progress` entries for the same `issue_id` as `failed`:

```sql
UPDATE phase_sub_iterations
   SET status = 'failed',
       completed_at = ?,
       summary = 'auto-marked failed: phase started a new sub-iteration without completing this one'
 WHERE issue_id = ?
   AND status = 'in-progress';
```

This is a small DB write inside the existing `start()` transaction. No new CLI surface. Document the behavior on `SubIterationStore.start()`.

### Decision 15 — Skill prompts

Full `SKILL.md` text for the three new skills is in Section 9.

Delete:
- `src/skills/prompt-writer/SKILL.md`
- The entire `src/skills/prompt-writer/` directory.

Any existing config that references `prompt-writer` in `skills.disabled` will silently fail to find it (resolveSkillPath returns null on missing skills, which is fine for the disabled list). No special migration needed.

### Decision 16 — Open-question routing in handleSuccess

In `orchestrator.handleSuccess`, after `recordUsageAndPublish` but before `advanceNormal`, branch on phase name:

```typescript
if (phase.name === "spec-writing") {
  const state = this.deps.pipelineState.get(issueId);
  const declared = state?.openQuestionCount ?? null;
  const parsed = state?.parsedOpenQuestionCount ?? null;
  const effective = Math.max(declared ?? 0, parsed ?? 0);

  if (declared !== parsed && declared !== null && parsed !== null) {
    this.deps.audit.log({
      component: "orchestrator",
      issueId,
      message: `Open-question count mismatch: declared=${declared} parsed=${parsed}; using max=${effective}`,
      metadata: { declared, parsed, effective },
    });
  }

  if (effective === 0 && this.deps.runtime.config.pipeline.skipSpecReviewIfReady === true) {
    await this.transitionTo(issueId, "coding", task);
    return;
  }
  // fall through to advanceNormal → spec-review
}
```

(Pseudo-code; integrate with the existing `handleSuccess` shape — note that `advanceNormal` is called near the end of `handleSuccess`, and we need to short-circuit before that. The actual implementation should fit cleanly into the existing flow without duplicating the `postPhase`-fetched-from-tracker check.)

Remove the no-op warning in `config.ts:323-325` once the knob has a consumer.

### Decision 17 — Pre-compute `humanModifiedSpec` in the orchestrator

**Decision:** The orchestrator computes the "human modified the spec" signal once when building the YAML context, using shared helpers in `src/core/strings.ts`. The signal is injected into the YAML context as `humanModifiedSpec: boolean`. The writer skill never computes hashes itself.

**Why this matters:** The naive alternative is for the skill to shell out `sed | sha256sum` to compute `hash_now`, then compare to `last_ai_spec_hash` from `redqueen pipeline get`. This couples two normalization implementations (shell-side and TS-side); any subtle drift causes every refine round to mis-detect as Case 3 (false "inline edit") and Case 4 (noop) can never fire. Pre-computing eliminates the binding entirely — there is no shell normalization to drift from the canonical TS normalization.

**Implementation:**

```typescript
// src/core/strings.ts (new file or extend existing utility)
import { createHash } from "node:crypto";

export function normalizeSpec(body: string): string {
  return body
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function computeHumanModifiedSpec(
  specContent: string | null,
  lastAiSpecHash: string | null,
): boolean {
  if (specContent === null || specContent.trim() === "") {
    return false; // empty spec — handled by spec_empty signal in the matrix
  }
  const currentHash = sha256Hex(normalizeSpec(specContent));
  return currentHash !== lastAiSpecHash;
}
```

```typescript
// In src/core/skill-context.ts buildSkillContext:
import { computeHumanModifiedSpec } from "./strings.js";

const humanModifiedSpec = computeHumanModifiedSpec(
  pipelineRecord.specContent,
  pipelineRecord.lastAiSpecHash,
);
const lastAiSpecAt = pipelineRecord.lastAiSpecAt;

// Add to SkillContext return:
return {
  // ... existing fields
  humanModifiedSpec,
  lastAiSpecAt,
};
```

`spec set` uses the same `normalizeSpec` + `sha256Hex` helpers when storing `last_ai_spec_hash`. Single source of truth.

**Edge case worth flagging:** for iter=0 + non-empty spec + `last_ai_spec_hash=null` (the "human pre-populated" case), `computeHumanModifiedSpec` returns `true` because `currentHash !== null`. This is intentional — Case 3 of the matrix folds the human content as an inline edit.

## 5. Implementation Approach

The work decomposes into 12 steps. Dependencies are noted; parallelism is possible where indicated.

### Step 1 — DB schema migrations

- Add 4 columns to `pipeline_state` via `runMigrations` in `database.ts`.
- Update `PipelineRow`, `PipelineRecord`, `toPipelineRecord` in `pipeline-state.ts` and `types.ts`.
- Add setter methods on `PipelineStateStore`: `setOpenQuestionCount`, `setParsedOpenQuestionCount`, `setLastAiSpec`.
- Confirm `resetIterations()` does NOT touch the new columns.

### Step 2 — Sub-iteration extensions

- Add stale-sweep to `SubIterationStore.start()` (Decision 14).
- Add `latestCompleted(issueId, phaseName)` method to `SubIterationStore` returning the most recent completed entry.
- Extend `src/cli/sub-iter.ts`:
  - `cmdSubIterComplete`: accept `--summary-stdin` as an alternative to `--summary "..."`. Read from stdin via `readBodyFromStdinOrFlag` (already exists in `src/cli/io.ts`).
  - Add `cmdSubIterLatest` for `sub-iter latest <issueId> --phase <name>`.

### Step 3 — `redqueen pipeline get` CLI

- Add `get` subcommand to `src/cli/pipeline.ts`. Returns full `PipelineRecord` as JSON via `writeJson(record, pretty)`. Errors if no record exists for the issue.
- Include the four new columns in the output (already part of `PipelineRecord` after step 1).

### Step 4 — `redqueen spec meta` CLI

- Add `meta` subcommand to `src/cli/spec.ts`.
- Args: positional `<issueId>`, options `--open-questions <N>`, `--files-affected <N>`. At least one option must be provided.
- Writes `open_question_count` (and `files_affected_count` if we want to land it now — though no orchestrator consumer reads it this phase, we can optionally defer the column).
- **Recommendation:** add `files_affected_count INTEGER` to the schema now (it's a single extra column) but don't wire it to routing. Forward-prep for v6 phase 6.

### Step 5 — Extend `redqueen spec set` and add `strings.ts`

Add `src/core/strings.ts` (or extend existing utility) with `normalizeSpec`, `sha256Hex`, and `computeHumanModifiedSpec`. Add `src/core/__tests__/strings.test.ts` covering:

- Normalization strips trailing whitespace per line.
- Normalization strips leading/trailing blank lines.
- Identical inputs hash identically.
- Byte-different inputs hash differently.
- `computeHumanModifiedSpec` returns `false` for null/empty spec content regardless of `lastAiSpecHash`.
- `computeHumanModifiedSpec` returns `true` when `specContent` is non-empty and `lastAiSpecHash` is null (the human-pre-populated case).
- `computeHumanModifiedSpec` returns `true` when the hashes diverge.

Update `src/cli/spec.ts` `cmdSpecSet`:

- Parse the spec body. Locate the `## Open Questions` section (case-insensitive heading match). Count `- [ ]` items (unchecked).
- Store the count in `pipeline_state.parsed_open_question_count`.
- Compute `sha256Hex(normalizeSpec(body))` and store in `last_ai_spec_hash`.
- Store the current ISO timestamp in `last_ai_spec_at`.
- All in the same transaction as the existing spec write (or the existing `pipelineState.updateSpec` call). The existing `updateSpec` only sets `spec_content`; we'll need either a new method that bundles the updates, or sequential calls inside a transaction.

Open-question parser (sketch):

```typescript
function countUncheckedOpenQuestions(body: string): number {
  const lines = body.split("\n");
  let inSection = false;
  let count = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#+\s/.test(line)) {
      inSection = /^#+\s+open questions\s*$/i.test(line);
      continue;
    }
    if (inSection && /^- \[\s\]/.test(line)) {
      count++;
    }
  }
  return count;
}
```

### Step 6 — `PhaseDefinition.iterationCounter` + skill-context refactor

- Add `iterationCounter?: "review" | "feedback" | "none"` to `PhaseDefinition` in `src/core/types.ts`.
- Add `lastAiSpecHash: string | null` and `lastAiSpecAt: string | null` to `PipelineRecord`.
- Add `humanModifiedSpec: boolean` and `lastAiSpecAt: string | null` to `SkillContext` in `skill-context.ts`.
- Extend `PhaseDefinitionSchema` in `src/core/config.ts` to validate the new field (defaulting to `"none"`).
- Rewrite `relevantIterationCount` in `src/core/skill-context.ts` to switch on the new field instead of string-matching the phase name.
- Update `buildSkillContext` to pass the `PhaseDefinition` (not just `phaseName`) into `relevantIterationCount`, and to compute and inject `humanModifiedSpec` + `lastAiSpecAt` using the helpers from `src/core/strings.ts`.
- Update YAML serialization to include `humanModifiedSpec` and `lastAiSpecAt`.

This step is independent of step 7 (phase graph delta) but logically precedes it because step 7 sets the new field.

### Step 7 — Phase graph delta in `defaults.ts`

- Remove the `spec-feedback` entry.
- Insert `spec-research` and `spec-design` ahead of `spec-writing` so `spec-research` is the entry phase (first in array).
- Modify `spec-writing`: change `skill` to `spec-writer`, add `maxIterations: 3`, `escalateTo: "blocked"`, `iterationCounter: "feedback"`.
- Modify `spec-review.rework` to `"spec-writing"`.
- Modify `spec-awaiting-info.next` to `"spec-research"`.
- Add `iterationCounter: "review"` to `code-review`, and `iterationCounter: "feedback"` to `code-feedback`.

### Step 8 — Orchestrator iteration-counter rewiring

This is the most subtle step. Reference the existing code:

- **Remove** the blanket `resetIterations` at `orchestrator.ts:302-315` (the gate-leave reset at the top of `processTask`).
- **Modify** `tryAutoTransitionRework` (currently at ~line 500): on successful auto-transition, before/after the `setPhase` call, reset `review_iterations` only (NOT both), then call `incrementFeedbackIterations`. If the new value > `targetPhase.maxIterations`, override the target and route to `escalateTo` instead. The current function returns `"transitioned"` or `"skip"`; introduce a third state if needed (`"escalated"`) or handle escalation inline.
- **Modify** `advanceNormal` (~line 907): when the prior phase was a human gate and the next phase is the gate's `.next`, reset both counters at this point. (Currently the reset happens unconditionally at the top of `processTask`; we're moving the responsibility into the advance path.)
- **Preserve** the existing `resetReviewIterationsOnPass` behavior in `handleSuccess` for `code-review` — this Alice-parity reset stays.
- **Other gate-leaves** (e.g. agent manually set phase, blocked unblocked via non-rework path): if we want to keep "reset both" behavior, we need a fallback in `respectAgentPhaseChange` or in `processTask` that checks "was the prior phase a human gate that we exited some other way" — reset both then. Simplest: in `processTask`, after determining the dispatch path but before dispatching, check if the prior phase was a human gate AND the destination isn't the rework target — if so, reset both. (The rework path resets only review_iterations and increments feedback_iterations as in tryAutoTransitionRework.) This requires restructuring slightly; the implementer should pick the cleanest call-site for the new logic.

Recommended end-state pseudo-code at the relevant call sites:

```typescript
// In tryAutoTransitionRework, after successful auto-transition to the rework target:
pipelineState.resetReviewIterations(issueId);
const newCount = pipelineState.incrementFeedbackIterations(issueId);
const target = phaseGraph.getPhase(targetPhase);
const cap = target?.maxIterations ?? 3;
if (newCount > cap) {
  const escalate = target?.escalateTo ?? "blocked";
  await this.transitionTo(issueId, escalate, task);
  return "escalated";   // new state
}
// continue to dispatch the rework target
```

```typescript
// In the gate-advance path (advancing from a human gate via .next):
if (previousWasHumanGate && nextPhase === gate.next) {
  pipelineState.resetIterations(issueId);   // both
}
```

```typescript
// In processTask, replace the blanket reset with:
//  Nothing.  Reset responsibility moves to advance and rework call sites.
// But: handle the "agent manually set phase to leave a gate" path explicitly.
//  In respectAgentPhaseChange or its caller, if the prior phase was a gate, reset both.
```

The implementer should write tests that lock in:

- Advance via `.next`: both counters → 0.
- Rework via `.rework`: review → 0, feedback incremented.
- Feedback reaches cap + 1 on rework: routes to escalateTo, does NOT dispatch the rework target.
- Code-review pass: review_iterations → 0 (Alice parity preserved).
- Multiple rework rounds back-to-back accumulate feedback_iterations correctly.

### Step 9 — Open-question routing in `handleSuccess`

Add the spec-writing branch as described in Decision 16. Tests should cover:

- `effective_open_questions === 0 && skipSpecReviewIfReady === true` → transition to coding.
- `effective_open_questions === 0 && skipSpecReviewIfReady === false` → spec-review (default path).
- `effective_open_questions > 0 && skipSpecReviewIfReady === true` → spec-review (skip suppressed by open questions).
- Declared and parsed disagree → audit log warning emitted, max used.

Remove the no-op warning in `config.ts:323-325` once the consumer exists.

### Step 10 — Skill files

- `rm -rf src/skills/prompt-writer/`
- Create `src/skills/spec-researcher/SKILL.md` (full text in Section 9.1).
- Create `src/skills/spec-designer/SKILL.md` (full text in Section 9.2).
- Create `src/skills/spec-writer/SKILL.md` (full text in Section 9.3).

The dist directory will be rebuilt by `npm run build`; no manual sync needed if the build copies skills (verify with the existing build script).

### Step 11 — Tests

Unit tests (vitest):

- `strings.test.ts`: normalization round-trip; sha256 determinism; `computeHumanModifiedSpec` for null/empty/non-empty + null/present `lastAiSpecHash` combinations.
- `pipeline-state.test.ts`: setter methods for new columns; `resetIterations` preserves new columns.
- `sub-iteration.test.ts`: stale-sweep on `start`; `latestCompleted` semantics.
- `skill-context.test.ts`: `iterationCounter` field drives counter selection; default = none; `humanModifiedSpec` and `lastAiSpecAt` injected into context; YAML serialization includes both fields.
- `orchestrator.test.ts`:
  - Counter reset semantics across advance vs rework gate-leave.
  - feedback_iterations cap → escalation to blocked.
  - Spec-writing success with `skipSpecReviewIfReady` and open_question_count combinations.
  - Empty-spec restart via `respectAgentPhaseChange` does NOT reset feedback_iterations.
- `cli/spec.test.ts`: `spec meta` writes both columns; `spec set` parses Open Questions, sets hash + timestamp.
- `cli/sub-iter.test.ts`: `latest` returns correct entry, `--summary-stdin` works.
- `cli/pipeline.test.ts`: `get` returns full record.

E2E (`__tests__/e2e/full-loop.test.ts` or a new spec-loop variant):

- Fresh ticket → spec-research → spec-design → spec-writing (Case 1) → spec-review.
- Gate-rework: human kicks back → spec-writing fires as Case 2 (with new comments) or Case 3 (with inline edits) → spec-review again.
- Multi-round rework: 4th rework attempt routes to blocked.
- Noop case: spec unchanged, no new comments → posts back, returns to gate, no new spec write.
- Skip-gate path: `skipSpecReviewIfReady: true` AND `open_question_count: 0` → coding.
- Human-pre-populated path: ticket created with `specContent` set, `last_ai_spec_hash` null → writer detects Case 3 (`iterationCount=0` + `humanModifiedSpec=true`) and refines.

### Step 12 — `npm run check` + clean up

- Run `npm run check` (`tsc + eslint + prettier`). Fix anything it flags.
- Run `npm test`. All tests green.
- Manual smoke test if a Jira sandbox is available.
- Commit incrementally per logical step (schema migration, CLI additions, orchestrator refactor, skills, tests).

## 6. Acceptance Criteria / Definition of Done

All of these must be objectively verifiable.

- [ ] `DEFAULT_PHASES` no longer contains `spec-feedback`; contains `spec-research` and `spec-design`.
- [ ] `spec-writing.skill === "spec-writer"`; `spec-writing.iterationCounter === "feedback"`; `spec-writing.maxIterations === 3`; `spec-writing.escalateTo === "blocked"`.
- [ ] `spec-review.rework === "spec-writing"`.
- [ ] `spec-awaiting-info.next === "spec-research"`.
- [ ] `src/skills/prompt-writer/` directory does NOT exist.
- [ ] `src/skills/spec-researcher/SKILL.md`, `src/skills/spec-designer/SKILL.md`, `src/skills/spec-writer/SKILL.md` all exist and match the prompts in Section 9.
- [ ] `pipeline_state` table has columns `open_question_count`, `parsed_open_question_count`, `last_ai_spec_hash`, `last_ai_spec_at`. (Optionally `files_affected_count`.)
- [ ] `PipelineStateStore.resetIterations()` does NOT touch the new columns (verified by unit test).
- [ ] `redqueen pipeline get <issueId>` returns valid JSON with all columns including the new ones.
- [ ] `redqueen spec meta <issueId> --open-questions N` writes to `open_question_count`.
- [ ] `redqueen spec set` updates `parsed_open_question_count`, `last_ai_spec_hash`, `last_ai_spec_at` atomically with `spec_content`.
- [ ] `redqueen sub-iter complete --summary-stdin` accepts stdin and writes to `summary`.
- [ ] `redqueen sub-iter latest <issueId> --phase <name>` returns the most recent completed entry or `null`.
- [ ] `SubIterationStore.start()` marks prior `in-progress` entries for the same issue as `failed`.
- [ ] `src/core/strings.ts` exports `normalizeSpec`, `sha256Hex`, `computeHumanModifiedSpec`; consumed by `cmdSpecSet` and `buildSkillContext`.
- [ ] Iteration-counter selection in `skill-context.ts` no longer string-matches phase names; uses `iterationCounter` config field.
- [ ] `buildSkillContext` injects `humanModifiedSpec` and `lastAiSpecAt` into the YAML context; verified by unit test.
- [ ] Counter reset semantics:
  - Advance via `.next` from a human gate resets both counters.
  - Rework via `.rework` resets review_iterations only, increments feedback_iterations.
  - feedback_iterations > maxIterations on rework routes to `escalateTo` (blocked), does NOT dispatch the rework target.
  - Manual phase exit from a gate (non-rework) resets both.
- [ ] Open-question routing in `handleSuccess` for `spec-writing`:
  - `max(declared, parsed) === 0 && skipSpecReviewIfReady === true` → coding.
  - Otherwise → spec-review.
  - Declared != parsed: audit log warning emitted.
- [ ] E2E: fresh ticket runs through `spec-research → spec-design → spec-writing → spec-review` end-to-end.
- [ ] E2E: gate-rework round 1 fires Case 2 or 3 (refine) and produces a revised spec.
- [ ] E2E: gate-rework round 4 (after 3 successful rework completions, the 4th kick) routes to `blocked`.
- [ ] E2E: noop case posts the tracker comment and returns to spec-review WITHOUT a new spec write (verify `last_ai_spec_at` unchanged).
- [ ] E2E: empty-spec restart re-enters via `spec-research`; feedback_iterations is incremented by the original rework dispatch and NOT reset by the agent-driven phase change.
- [ ] E2E: human-pre-populated spec on a fresh ticket triggers writer Case 3 (refine) instead of overwriting.
- [ ] `npm run check` passes.
- [ ] `npm test` passes.
- [ ] `config.ts:323-325` no-op warning for `skipSpecReviewIfReady` is removed.

## 7. Out of Scope

Explicitly excluded from this phase. Do not touch:

- Inline PR review threads / `redqueen pr review-thread` CLI.
- Reviewer skill rewrite (rating removal, thread dedup, blocker vs improvement classification).
- Coder skill rewrite with `priorPhase` branching.
- `priorPhase TEXT NULL` column on pipeline_state.
- Tester skill PR-comment publishing.
- `review_exhausted` column and final-test carve-out.
- `code-review.escalateTo` change from `human-review` to `testing`.
- Dashboard rendering of `phase_sub_iterations` data.
- Pre-generated global codebase map at `redqueen init`.
- Per-issue codebase notes checked into the repo.
- Explicit `spec-restart` CLI or phase (the empty-spec auto-restart via `respectAgentPhaseChange` covers this case).
- Reviewer/coder disagreement arbitration mechanisms.
- Server-side regex sniff for `TBD` / `FIXME` markers outside the `## Open Questions` section. Prompt calibration is the sole defense; revisit only if real runs show drift.
- Adding a `redqueen spec hash --stdin` CLI. The orchestrator pre-computes `humanModifiedSpec` (Decision 17), so the skill never needs to compute hashes.

If you find yourself touching files in `src/skills/reviewer/`, `src/skills/coder/`, `src/skills/tester/`, `src/skills/comment-handler/`, or adding `prior_phase` / `review_exhausted` columns — stop. Those are later phases.

## 8. Open Questions or Unknowns

These were flagged during design and deferred for the implementer to resolve in-flight or flag back to the user:

1. **`spec-awaiting-info.next → spec-research`** vs keeping it pointed at `spec-writing`. The design picks `spec-research` (lets fresh research absorb the human's clarification). Cost: one extra research+design pass after every awaiting-info round. If profiling shows this is wasteful, revert to `spec-writing` and have the writer fold the human comment in directly.

2. **Tracker visibility of research/design findings.** Current design keeps them dashboard-only via `phase_sub_iterations`. If humans complain about black-box behavior, surface findings as collapsed tracker comments in a later phase. Adding visibility later is cheap; removing it is harder.

3. **Files-affected column.** The v6 doc mentions `--files-affected N` on `spec meta`. No orchestrator consumer reads it this phase. Recommendation: land the column and CLI flag now (single extra column) but do not route on it; future-prep without much cost. If you prefer minimalism, defer the column entirely until a consumer exists.

4. **Stale sub-iteration sweep visibility.** The sweep silently marks orphan entries as `failed`. If multiple phases race (impossible today — single worker pool), the sweep could mask real progress. Not a concern with the current single-worker model. Document the behavior clearly so future concurrency adds know to reconsider.

5. **Counter reset behavior on manual agent phase change to a gate.** If a skill calls `set-phase blocked` mid-loop, the issue enters a gate. When the human unblocks (via `blocked.next: coding`, say), the gate-leave reset fires. Under the new semantics, this advance via `.next` resets both counters. That's probably correct — the human looking at a blocked issue should get a fresh budget — but worth confirming during testing. If undesired, narrow the "reset both" path further.

## 9. Notes for the Implementation Agent

### 9.0 Critical gotchas

- **The reset-semantics refactor (Step 8) is the biggest risk in this phase.** Test exhaustively. The current behavior (blanket reset on gate-leave) is conservative-safe; the new behavior must precisely match the table in Decision 9. Edge cases: agent-driven phase changes that bypass `tryAutoTransitionRework`, blocked unblock, rework escalation to blocked.
- **`incrementFeedbackIterations` is dead code today.** Wiring it up in `tryAutoTransitionRework` is a real behavioral change. The existing tests at `src/core/__tests__/orchestrator.test.ts:905` and `:1004-1005` exercise the COUNTER but not the increment via the rework path. New tests required.
- **`feedback_iterations > maxIterations` check timing.** Increment FIRST, then check. If iter goes from 2 → 3 and cap is 3, that's the last legal rework; the next kick goes from 3 → 4, escalates. The skill's `maxIterations - 1` self-warning in the prompt accounts for this (state "last automated revision" when `iterationCount === maxIterations - 1`).
- **`humanModifiedSpec` is the single source of truth for "human edited the spec."** The orchestrator computes it via the shared `src/core/strings.ts` helpers; the skill reads it from YAML and never recomputes. If you find yourself shelling `sed | sha256sum` inside a skill, you've gone wrong — go fix the orchestrator/strings module instead.
- **`computeHumanModifiedSpec` semantics for the human-pre-populated case.** When `specContent` is non-empty and `lastAiSpecHash` is null, the function returns `true` (`currentHash !== null` → true). This is what makes iter=0 + content fall into Case 3 cleanly. Do NOT add a special case to suppress this.
- **Skill prompts assume the worktree exists** in Cases 2/3. The cleanup at the end of a successful write REMOVES the worktree, so the next dispatch will recreate it. The refresh-or-create pattern handles this.
- **`redqueen sub-iter latest` must filter by `status = 'completed'`.** If research crashed and the stale-sweep hasn't fired yet (e.g., this is the very next dispatch before another `start` triggers the sweep), the in-progress orphan could be returned. The completed-only filter avoids this.
- **`respectAgentPhaseChange` already handles agent phase changes** including the agent setting phase to a downstream phase. Case 5 (empty restart) leans on this without needing new orchestrator code. Verify the existing tests cover the "agent set phase to entry phase" case; add one if not.
- **Don't forget to update the YAML context block** in `skill-context.ts`. The new `iterationCount` selection logic needs the `PhaseDefinition`. Make sure `buildSkillContext` passes it. Also add `humanModifiedSpec` and `lastAiSpecAt` to both the `SkillContext` interface and the YAML serialization. Also note: `phaseName` should remain in the YAML context for skills that want to reference it (the skills below do not branch on it, but it's harmless to keep).
- **Test fixtures referencing `spec-feedback`** exist in `src/core/__tests__/fixtures/test-config.ts` and other test files. Search-and-replace carefully; some may need to be deleted rather than rewritten if they were specifically testing spec-feedback behavior.
- **Don't delete the noop-warning audit log** until step 9 is complete and the consumer exists; otherwise leaving `skipSpecReviewIfReady: true` in a config has no visible effect at all.

### 9.1 spec-researcher SKILL.md (full text)

```markdown
---
name: spec-researcher
description: Explores the codebase scoped to an issue and produces a concise, structured findings report (affected files, functions, patterns, tests, dependencies). Does not propose solutions or write the spec. Use as the first sub-phase of the spec-writing pipeline.
license: MIT
compatibility: Designed for the Red Queen orchestrator pipeline
metadata:
  phase: spec-research
  version: "1.0"
---

# Spec Researcher

You investigate the codebase for an issue and produce a focused findings report. You do not propose changes, name a design, or write the spec — that is the next two phases. Your output is consumed by the designer and writer that come after you.

## Logging rule

Routine progress goes to the audit log automatically. Only post a tracker comment when:

1. You set the issue to **Awaiting Info** — the ticket is too vague to scope research against. Explain what is unclear.
2. You set the issue to **Blocked** — structural issue (e.g. repository state contradicts the ticket).

## Input

Read the YAML context block. Fields you rely on:

- `issueId` — the issue key. Used in CLI calls and the worktree path.
- `projectDir` — absolute project root. All exploration is scoped under here or the worktree you create.
- `baseBranch` — `origin/<name>` form. Pass verbatim to `git worktree add`; strip `origin/` when you need the bare branch name.
- `codebaseMapPath` — path to the codebase map; read first if non-null.
- `iterationCount` — always 0 for this phase. Re-runs happen only when the human kicks the spec back through awaiting-info, at which point this is a fresh dispatch.

## Execution

### Step 1: Read the ticket

```
redqueen issue get "${issueId}"
```

Parse the JSON. You care about `summary`, the description, and prior comments via `redqueen issue comments "${issueId}"`.

### Step 2: Fetch attachments

```
redqueen issue attachments "${issueId}"
```

If the array is non-empty, read each `localPath` with vision. Note what each image shows in your findings (the writer needs to know they exist).

### Step 3: Open the sub-iteration

```
redqueen sub-iter start "${issueId}" "Codebase research"
```

This claims the dashboard slot and gives the writer something to read later.

### Step 4: Triage the ticket

If after reading you cannot identify what the ticket is asking for:

```
echo "<specific clarifying questions>" | redqueen issue comment "${issueId}"
if ! redqueen issue set-phase "${issueId}" spec-awaiting-info; then
  echo "Could not route to spec-awaiting-info — summary: phase-change failed"
  exit 1
fi
exit 0
```

Only use this for questions a human can answer in one comment. Structural blockers go to `blocked` (bottom of file).

### Step 5: Create or refresh the spec worktree

```
bare_base=$(echo "${baseBranch}" | sed 's|^origin/||')
worktree="${projectDir}/.redqueen/worktrees/spec-${issueId}"
git fetch origin "${bare_base}"
if [ -d "${worktree}" ]; then
  git -C "${worktree}" fetch origin "${bare_base}"
  git -C "${worktree}" reset --hard "${baseBranch}"
else
  git worktree add "${worktree}" "${baseBranch}"
fi
```

From here, all Glob / Grep / Read happens inside `${worktree}`.

### Step 6: Explore

Use Glob / Grep / Read to find:

- **Affected modules** — which files/functions will the change touch?
- **Existing patterns** — naming, structure, error handling, tests in this area.
- **Test files** — which test files cover the affected modules?
- **Dependencies** — internal callers/callees, external libraries.
- **Adjacent code** — anything the writer must be aware of.

Stay scoped. You are not mapping the whole codebase, only the territory the ticket touches.

### Step 7: Write findings

Produce a structured plain-text report (markdown formatting is fine; this is rendered in the dashboard, not on Jira). Recommended structure:

- **Affected modules:** bulleted list of `path/file.ext:lineRange — short description`.
- **Existing patterns:** how this area solves similar problems today.
- **Test files:** which tests need updating; existing test patterns to match.
- **Dependencies:** internal + external; anything the writer must coordinate with.
- **Attachments:** one line per image if any (the writer cannot see images directly).
- **Notes:** quirks, gotchas, things the writer should re-verify.

Keep it dense and concrete. Name files and functions with line ranges. Do not propose changes.

**Aim for findings under ~5 pages / 3KB of text.** Cut anything not directly load-bearing for the writer. The designer and writer both load this report into their context windows on subsequent dispatches — token cost compounds.

### Step 8: Close the sub-iteration

```
cat <<'EOF' | redqueen sub-iter complete "${issueId}" --summary-stdin
<findings report>
EOF
```

Use stdin to avoid argv length limits.

### Step 9: Final summary (stdout)

One line naming the main modules you investigated. This becomes `priorContext` for the designer.

## When to set Blocked

Trigger Blocked when the codebase contradicts the ticket in a way no clarification can fix (e.g. the named module does not exist and there is no clear successor).

1. Post a tracker comment explaining the contradiction and what the human must do.
2. `redqueen issue set-phase "${issueId}" blocked` (exit non-zero on failure):

   ```
   if ! redqueen issue set-phase "${issueId}" blocked; then
     echo "Could not route to blocked — summary: phase-change failed"
     exit 1
   fi
   ```

3. Exit 0. Include "Blocked — <reason>" in your stdout summary.

## What this skill does NOT do

- Propose solutions or designs.
- Suggest which approach is better.
- Write any part of the spec.
- Run the build or tests.
- Modify any code.

If you find yourself writing "we should ..." in the findings, you have crossed the line. Restate as "current behavior is ..." or move the proposal to your stdout summary for the designer to consider.
```

### 9.2 spec-designer SKILL.md (full text)

```markdown
---
name: spec-designer
description: Sketches the implementation approach for an issue from research findings, naming key decisions and open questions. Does not write the spec or implement code. Use as the second sub-phase of the spec-writing pipeline.
license: MIT
compatibility: Designed for the Red Queen orchestrator pipeline
metadata:
  phase: spec-design
  version: "1.0"
---

# Spec Designer

You sketch the implementation approach for the ticket. You consume the researcher's findings and produce a design output that the writer turns into a full spec. You do not write the spec yourself.

## Logging rule

Routine progress goes to the audit log automatically. Only post a tracker comment when:

1. You set the issue to **Awaiting Info** — research surfaced an ambiguity that needs the human.
2. You set the issue to **Blocked** — structural issue.

## Input

Read the YAML context block. Fields you rely on:

- `issueId` — the issue key.
- `projectDir` — project root. The spec worktree lives at `${projectDir}/.redqueen/worktrees/spec-${issueId}`.
- `baseBranch` — `origin/<name>` form. Refresh the worktree if you need to verify a design assumption.
- `priorContext` — the researcher's one-line summary.
- `iterationCount` — always 0 for this phase.

## Execution

### Step 1: Read the ticket and the research findings

```
redqueen issue get "${issueId}"
redqueen sub-iter latest "${issueId}" --phase spec-research
```

The sub-iter command returns the most recent completed entry as JSON. Read `summary` — that is the researcher's full report.

If the research summary or `priorContext` indicates new questions surfaced after research started, re-read recent comments:

```
redqueen issue comments "${issueId}"
```

### Step 2: Fetch attachments

```
redqueen issue attachments "${issueId}"
```

Read each `localPath` with vision. The researcher already noted what each shows; you decide which ones inform the design.

### Step 3: Open the sub-iteration

```
redqueen sub-iter start "${issueId}" "Solution design"
```

### Step 4: Refresh the worktree if needed

The researcher left a worktree at `${projectDir}/.redqueen/worktrees/spec-${issueId}`. Refresh it only if you need to verify a design assumption:

```
bare_base=$(echo "${baseBranch}" | sed 's|^origin/||')
worktree="${projectDir}/.redqueen/worktrees/spec-${issueId}"
if [ -d "${worktree}" ]; then
  git -C "${worktree}" fetch origin "${bare_base}"
  git -C "${worktree}" reset --hard "${baseBranch}"
else
  git fetch origin "${bare_base}"
  git worktree add "${worktree}" "${baseBranch}"
fi
```

You are not required to touch code here. If the research findings answer all your design questions, skip this step.

### Step 5: Sketch the approach

Produce a design output with these elements:

- **Approach:** one or two paragraphs describing what to change at the architecture level. Not file-level — the writer fills that in.
- **Key decisions:** numbered list of important choices you made. For each: the alternative you considered, why you rejected it.
- **Open questions:** unresolved items that the writer must either answer (via focused code reading) or surface in the spec's Open Questions section for humans.
- **Risks:** non-obvious things the writer must call out as Risks & Pitfalls in the final spec.

Do not write code paths, full file lists, test plans, or step-by-step implementation instructions. Those belong in the writer's spec.

### Step 6: Close the sub-iteration

```
cat <<'EOF' | redqueen sub-iter complete "${issueId}" --summary-stdin
<design output>
EOF
```

### Step 7: Final summary (stdout)

One line naming the approach (e.g. "Approach: server-side parse in spec set, layered validation in spec meta"). This becomes `priorContext` for the writer.

## When to set Blocked / Awaiting Info

- **Awaiting Info:** research turned up an ambiguity only the human can resolve. Post the question, set phase to spec-awaiting-info, exit 0.
- **Blocked:** the design cannot be made coherent (e.g. a hard constraint surfaced during design that contradicts the ticket goal). Post the explanation, set phase to blocked, exit 0.

In both cases:

```
echo "<question or explanation>" | redqueen issue comment "${issueId}"
if ! redqueen issue set-phase "${issueId}" <spec-awaiting-info|blocked>; then
  echo "Could not route — summary: phase-change failed"
  exit 1
fi
exit 0
```

## What this skill does NOT do

- Write the full spec (no Files to Change, no Implementation Steps, no Test Plan).
- Implement code or run tests.
- Format open questions as checkboxes (the writer does that).
- Make scope-expanding decisions without flagging them as Open Questions.

If you find yourself enumerating file paths line-by-line or drafting test cases, you have crossed into writer territory. Step back to the architectural level.
```

### 9.3 spec-writer SKILL.md (full text)

```markdown
---
name: spec-writer
description: Writes or revises the implementation specification a coder will use as its single source of truth. Branches on iteration count, presence of spec content, and pre-computed human-modification signal from the YAML context. Use as the third sub-phase of the spec-writing pipeline.
license: MIT
compatibility: Designed for the Red Queen orchestrator pipeline
metadata:
  phase: spec-writing
  version: "1.0"
---

# Spec Writer

You write the implementation specification. The coder downstream sees only the spec — every file, function, and acceptance criterion must appear in it. You consume the researcher's findings and the designer's approach.

## Logging rule

Routine progress goes to the audit log automatically. Only post a tracker comment when:

1. You set the issue to **Awaiting Info** — fresh write (Case 1) only; never on rework.
2. You set the issue to **Blocked** — any case.
3. You hit the **Noop** case (Case 4) — post "no changes requested, returning to review".

## Input

Read the YAML context block. Fields you rely on:

- `issueId` — the issue key.
- `projectDir` — project root. The spec worktree is at `${projectDir}/.redqueen/worktrees/spec-${issueId}`.
- `baseBranch` — `origin/<name>` form. Refresh the worktree as needed to verify open questions.
- `specContent` — `null` on fresh write; populated on rework or when a human has pre-populated the spec on the tracker.
- `humanModifiedSpec` — `true` when the current `specContent` differs from what the AI last wrote (or when a human has pre-populated and the AI has not yet written). Pre-computed by the orchestrator using a normalized hash. Authoritative — do not recompute.
- `lastAiSpecAt` — ISO timestamp of the last AI `spec set` write, or `null`. Use to filter comments: human comments newer than `lastAiSpecAt` are "new since last AI write."
- `iterationCount` — number of times this phase has run in the current rework loop. 0 = first dispatch from the design phase, ≥1 = rework round N.
- `maxIterations` — escalation cap. On the final iteration, state in your summary that this is the last automated revision.
- `priorContext` — short one-liner from the designer (fresh) or from the rework gate exit (rework).

## Branching matrix

Compute one local signal:

```
# new_comments: comments where createdAt > lastAiSpecAt AND author != AI account.
# If lastAiSpecAt is null, treat ALL comments as new (no AI write has happened yet).
```

`spec_empty` is true if `specContent` is null or whitespace-only.

Choose exactly one case before doing anything else:

| Case | iterationCount | spec_empty | humanModifiedSpec | new_comments | Action |
|------|---------------:|------------|-------------------|--------------|--------|
| 1    | 0              | true       | n/a               | n/a          | Fresh write |
| 2    | ≥1             | false      | false             | yes          | Refine (fold new comments) |
| 3    | any            | false      | true              | n/a          | Refine (fold inline edits + new comments if any) |
| 4    | ≥1             | false      | false             | no           | Noop |
| 5    | ≥1             | true       | n/a               | n/a          | Restart through research+design |

Case 3 also catches the human-pre-populated case: ticket arrives with `specContent` non-null on a fresh dispatch (iter=0), `humanModifiedSpec` will be `true` because the AI has not yet written (so the human's content does not match the AI's last hash, which is null). Fold the human's content as if it were an inline edit.

## Setup (all cases except Noop and Restart)

1. If `codebaseMapPath` is non-null, read it.
2. If `.redqueen/references/spec-template.md` exists under `projectDir`, read it. Your spec follows that structure.
3. `redqueen issue get "${issueId}"` for the ticket.
4. `redqueen issue attachments "${issueId}"` and read each image with vision.
5. `redqueen sub-iter latest "${issueId}" --phase spec-research` — read the findings.
6. `redqueen sub-iter latest "${issueId}" --phase spec-design` — read the design output.
7. Open the writer sub-iteration:

   ```
   redqueen sub-iter start "${issueId}" "Writing spec"
   ```

## Case 1: Fresh write

Refresh the worktree at `${projectDir}/.redqueen/worktrees/spec-${issueId}` (researcher created it; refresh if it exists, create if it does not).

Verify file paths and function names named in the design output before committing to them in the spec — the design might be slightly stale.

Required sections (follow `.redqueen/references/spec-template.md` if present, else this fallback):

- **Problem** — what changes and why.
- **Root Cause / Context** — the existing code area being modified.
- **Files to Change** — exhaustive list with function/class names.
- **Implementation Steps** — numbered, atomic.
- **Test Plan** — each acceptance criterion mapped to a verification.
- **Non-Goals** — explicit scope limits.
- **Open Questions** — checkbox list (`- [ ]`). Only items the human alone can answer.
- **Risks & Pitfalls** — non-obvious traps.
- **Attachment Analysis** — omit if no attachments.

**The `## Open Questions` heading must be exactly that — no decoration (`(3)`, `:`, trailing dash, etc).** The server-side parser uses the regex `/^#+\s+open questions\s*$/i` to find the section. Decorated headings will be silently skipped.

Try to resolve open questions yourself by re-reading code before flagging for human. Only genuinely human-needed items go in the Open Questions section.

**Any `TBD`, `FIXME`, `<placeholder>`, or `?`-hedge anywhere in the spec body counts as an open question and MUST be moved into the `## Open Questions` section before submission.** The parser only counts `- [ ]` items in that section; misplaced markers will not be caught and will result in the spec being routed past the human gate with unresolved questions.

Save and close:

```
cat <<'EOF' | redqueen spec set "${issueId}"
<spec body>
EOF
redqueen spec meta "${issueId}" --open-questions <N>
```

`N` is the count of unchecked `- [ ]` items in your Open Questions section.

Clean up the worktree:

```
git worktree remove "${projectDir}/.redqueen/worktrees/spec-${issueId}" \
  || git worktree remove --force "${projectDir}/.redqueen/worktrees/spec-${issueId}" \
  || true
```

Complete the sub-iteration:

```
echo "Fresh spec written — N open questions" | redqueen sub-iter complete "${issueId}" --summary-stdin
```

Exit 0. Stdout: one line summarizing the spec.

## Cases 2 & 3: Refine

Refresh the worktree (it may have been removed by a prior iteration's cleanup):

```
bare_base=$(echo "${baseBranch}" | sed 's|^origin/||')
worktree="${projectDir}/.redqueen/worktrees/spec-${issueId}"
if [ -d "${worktree}" ]; then
  git -C "${worktree}" fetch origin "${bare_base}"
  git -C "${worktree}" reset --hard "${baseBranch}"
else
  git fetch origin "${bare_base}"
  git worktree add "${worktree}" "${baseBranch}"
fi
```

Re-fetch comments to identify what changed:

```
redqueen issue comments "${issueId}"
```

Filter comments to those newer than `lastAiSpecAt` from a non-AI author. For Case 3, also diff the current `specContent` against the prior AI-written version conceptually (you do not have the prior version verbatim, but the inline-edit pattern is typically obvious from the spec body itself).

For each new human comment AND each inline-edit, classify and apply:

- **Diagnosis change** — reviewer disagrees with the root cause. Revise Root Cause / Context.
- **Scope change** — files / acceptance criteria added or removed. Update Files to Change and Test Plan.
- **Question answered** — uncheck or remove an Open Question; fold the answer into the right section.
- **Clarification** — wording or structure adjustment.

For the human-pre-populated case (iter=0, content present, no prior AI write): treat the existing `specContent` as the human's draft to fold and improve. Preserve their wording where it works; restructure to match the spec template; add the sections they omitted.

Produce a complete replacement spec — no FEEDBACK markers, no track-changes annotations. The heading and TBD/FIXME rules from Case 1 apply.

Save and close (same as Case 1):

```
cat <<'EOF' | redqueen spec set "${issueId}"
<revised spec>
EOF
redqueen spec meta "${issueId}" --open-questions <N>
```

Clean up the worktree (same as Case 1).

Complete the sub-iteration:

```
echo "Revised spec — fold <list of changes>; N open questions" | redqueen sub-iter complete "${issueId}" --summary-stdin
```

Exit 0. Stdout: name the main changes for the next review.

## Case 4: Noop

Post a tracker comment:

```
echo "No changes requested since the last revision — returning to spec review without changes." | redqueen issue comment "${issueId}"
```

Route back to the gate:

```
if ! redqueen issue set-phase "${issueId}" spec-review; then
  echo "Could not route to spec-review — summary: phase-change failed"
  exit 1
fi
```

Complete the sub-iteration:

```
echo "Noop — no new comments and spec unchanged since last AI write" | redqueen sub-iter complete "${issueId}" --summary-stdin
```

Exit 0. Stdout: "Noop — no changes requested".

Do NOT touch the spec content or call `spec meta`. Do NOT clean up or refresh the worktree (it may still be useful next round).

## Case 5: Restart

The human cleared the spec entirely (the tracker field is now empty). Route back to spec-research; the orchestrator's respect-agent-phase-change path picks it up.

```
if ! redqueen issue set-phase "${issueId}" spec-research; then
  echo "Could not route to spec-research — summary: phase-change failed"
  exit 1
fi
echo "Restart — spec was cleared by human; re-traversing research+design" | redqueen sub-iter complete "${issueId}" --summary-stdin
```

Exit 0. Stdout: "Restart — spec cleared, re-running research+design".

Note: `feedback_iterations` is NOT reset by this transition (you are not leaving a human gate). The restart counts against your rework budget.

Do NOT call `spec set`, `spec meta`, or touch the worktree.

## Open-question accounting

After writing the spec, you state a count via `redqueen spec meta --open-questions N`. The `redqueen spec set` command additionally parses the spec body's `## Open Questions` section and stores a `parsed_open_question_count` for cross-check. The orchestrator routes on `max(declared, parsed)` — safer default = gate.

What counts as an open question:

- Each `- [ ]` checkbox under `## Open Questions`.
- Any `TBD`, `FIXME`, `?` placeholder, `<placeholder>`, or unresolved hedge anywhere in the spec body. Move these into the Open Questions section before submitting; the parser does NOT catch markers outside the section.
- Anything you wrote because "the human will know."

What does NOT count:

- `- [x]` checked items (you resolved them).
- Question marks inside legitimate prose that you answer in the same paragraph.

## When to set Blocked

If you cannot produce a usable spec (e.g. design and reality contradict in a way that needs human triage):

1. Post a tracker comment explaining what blocks and what is needed.
2. `redqueen issue set-phase "${issueId}" blocked` (exit non-zero on failure).
3. Exit 0. Stdout: "Blocked — <reason>".

## When to set Awaiting Info (fresh write only — Case 1)

If on fresh write the ticket is too vague to scope a spec against and the researcher missed it:

1. Post questions via `redqueen issue comment`.
2. `redqueen issue set-phase "${issueId}" spec-awaiting-info` (exit non-zero on failure).
3. Exit 0.

On rework (any case ≥1) do NOT route to awaiting-info. The input is disagreement, not absence. Route to Blocked instead if the feedback itself is incoherent.

## Quality standards

- **Self-contained** — the coder sees only the spec.
- **Specific** — every file, function, symbol named.
- **Testable** — each acceptance criterion has a verification step.
- **Scoped** — Non-Goals are explicit.
- **Honest** — uncertainties go in Open Questions, not guessed.
- **Standard markdown only** — backticks, fences, `**bold**`, `- bullets`, `[text](url)`. No Jira wiki syntax (`{{x}}`, `{code}…{code}`, `h1.`, `||header||`).

## Iteration cap

When `iterationCount >= maxIterations - 1`, state in your final summary that this is the last automated revision before escalation.
```

### 9.4 Quick reference for the implementer

Files you will modify:

- `src/core/types.ts` — add `iterationCounter` to `PhaseDefinition`; add `openQuestionCount`, `parsedOpenQuestionCount`, `lastAiSpecHash`, `lastAiSpecAt` to `PipelineRecord`.
- `src/core/config.ts` — extend `PhaseDefinitionSchema` with `iterationCounter`; remove the no-op `skipSpecReviewIfReady` warning.
- `src/core/defaults.ts` — rewrite phase graph per Decision 8.
- `src/core/database.ts` — add 4 (or 5 with files_affected) columns to `pipeline_state` via runMigrations.
- `src/core/pipeline-state.ts` — add `PipelineRow` columns + `toPipelineRecord` + new setter methods.
- `src/core/skill-context.ts` — replace string-matching iteration-counter selection; add `humanModifiedSpec` and `lastAiSpecAt` to `SkillContext` and YAML serialization.
- `src/core/orchestrator.ts` — counter reset refactor (Step 8), open-question routing in handleSuccess (Step 9).
- `src/core/sub-iteration.ts` — stale-sweep in `start`, `latestCompleted` method.
- `src/cli/sub-iter.ts` — stdin support on complete; new `latest` subcommand.
- `src/cli/spec.ts` — extend `set` with parsing + hash + timestamp using `strings.ts` helpers; add `meta` subcommand.
- `src/cli/pipeline.ts` — add `get` subcommand.

Files you will create:

- `src/core/strings.ts` — `normalizeSpec`, `sha256Hex`, `computeHumanModifiedSpec`. (Or extend an existing utility module if one already covers strings.)
- `src/core/__tests__/strings.test.ts` — round-trip and determinism coverage.
- `src/skills/spec-researcher/SKILL.md` — text from 9.1.
- `src/skills/spec-designer/SKILL.md` — text from 9.2.
- `src/skills/spec-writer/SKILL.md` — text from 9.3.

Files/directories you will delete:

- `src/skills/prompt-writer/` (whole directory).

Tests that exist today and will need updates:

- `src/core/__tests__/orchestrator.test.ts` — any test asserting the blanket gate-leave reset behavior needs revising.
- `src/core/__tests__/skill-context.test.ts` — string-pattern matching test removed; replace with iterationCounter-config tests; add `humanModifiedSpec` + `lastAiSpecAt` injection coverage.
- `src/core/__tests__/fixtures/test-config.ts` — replace `spec-feedback` references.
- `src/__tests__/e2e/full-loop.test.ts` — phase sequence changes from `spec-writing → spec-review → coding` to `spec-research → spec-design → spec-writing → spec-review → coding`.

Tests to add:

- `strings.test.ts`: normalization, sha256 determinism, `computeHumanModifiedSpec` covering null/empty/non-empty content × null/present `lastAiSpecHash` combinations.
- Five-case branching matrix (one test per case, asserting side effects). Include the human-pre-populated row (iter=0, content present, no prior AI write).
- Counter reset semantics: advance vs rework vs other-gate-leave.
- Cap escalation: 4th rework round routes to blocked.
- Stale-sweep marks orphans failed.

### 9.5 Sequencing recommendations

Land in this order to keep `npm run check` and tests passing at every commit:

1. Schema + types (Step 1) — no behavior change yet; everything still uses old code paths.
2. CLIs (Steps 2-5) — additive surface area; existing callers untouched. `strings.ts` lands as part of Step 5.
3. `iterationCounter` field + skill-context refactor (Step 6) — internal refactor; phase graph still uses string-match-friendly names so nothing breaks. `humanModifiedSpec` injection lands here; nothing reads it yet.
4. Phase graph delta (Step 7) — at this point the entry phase changes; coordinate with test fixture updates.
5. Orchestrator reset/cap rewiring (Step 8) — biggest behavioral change; lock in tests first.
6. Open-question routing (Step 9) + remove no-op warning.
7. Skill file rename (Step 10).
8. Test coverage (Step 11).
9. `npm run check` + cleanup (Step 12).

If you absolutely must squash, the combined refactor still works — but the diff will be large and review-hostile. Recommend at least 3-4 commits separating schema/CLI/orchestrator/skills.
