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
