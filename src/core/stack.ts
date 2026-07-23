// Stacked-branch dependency resolution. Pure deterministic logic — no git, no
// AI, no direct API clients; everything external comes in through deps.
//
// A blocker is "satisfied" when its code is reachable by a dependent: merged
// to base (phase done), closed outside RQ, or parked at the terminal human
// gate with a PR up. Satisfied-at-gate blockers contribute their branch; the
// dependent assembles its worktree by merging those branches in topo order.

import type { BlockerRef } from "../integrations/issue-tracker.js";
import type { PhaseGraph, PipelineRecord } from "./types.js";

export interface StackProblem {
  issueId: string;
  kind: "missing-branch" | "lookup-failed";
  detail: string;
}

export interface StackResolution {
  ok: boolean;
  directBlockers: BlockerRef[];
  // Ancestor branches to merge, topologically ordered (furthest ancestor
  // first), lowest ticket number popped first on ties.
  mergeBranches: string[];
  // Branch the dependent's PR targets: the nearest contributing blocker's
  // branch (BFS layers from the root, lowest ticket number on ties), else the
  // bare base branch. Never bare base while mergeBranches is non-empty — a PR
  // against base would make gated ancestors' unreviewed code mergeable.
  prBase: string;
  unsatisfied: string[];
  cycle: string[] | null;
  problems: StackProblem[];
}

export interface StackResolveDeps {
  getBlockedBy(issueId: string): Promise<BlockerRef[]>;
  getPipelineRecord(issueId: string): PipelineRecord | null;
  getTrackerPhase(issueId: string): Promise<string | null>;
  terminalGates: ReadonlySet<string>;
}

// Terminal human gates are the ones that exit to done — an issue parked there
// with a PR up has finished automated work (passed review + testing). The
// escalation "blocked" gate exits back into the pipeline and never qualifies.
export function terminalGateNames(graph: PhaseGraph): Set<string> {
  return new Set(
    graph
      .getHumanGates()
      .filter((g) => g.next === "done")
      .map((g) => g.name),
  );
}

// pipeline.baseBranch is configured in origin/<name> remote-ref form; branch
// comparisons, PR bases, and fetch refspecs need the bare name.
export function bareBaseBranch(configured: string): string {
  return configured.startsWith("origin/") ? configured.slice("origin/".length) : configured;
}

// Trailing digits of an issue id: "PROJ-123" → 123, "#45" → 45,
// "owner/repo#7" → 7. Ids without digits sort last (Infinity).
export function ticketNumber(id: string): number {
  const match = /(\d+)$/.exec(id);
  if (match === null) {
    return Number.POSITIVE_INFINITY;
  }
  return Number.parseInt(match[1] ?? "", 10);
}

function compareTickets(a: string, b: string): number {
  const na = ticketNumber(a);
  const nb = ticketNumber(b);
  if (na < nb) {
    return -1;
  }
  if (na > nb) {
    return 1;
  }
  return a.localeCompare(b);
}

type Satisfaction =
  | { state: "satisfied"; branch: string | null }
  | { state: "unsatisfied" }
  | { state: "missing-branch" };

export async function resolveStack(
  issueId: string,
  bareBase: string,
  deps: StackResolveDeps,
): Promise<StackResolution> {
  // Root lookup failures propagate — the caller defers with <resolve-error>.
  const directBlockers = await deps.getBlockedBy(issueId);
  if (directBlockers.length === 0) {
    return {
      ok: true,
      directBlockers: [],
      mergeBranches: [],
      prBase: bareBase,
      unsatisfied: [],
      cycle: null,
      problems: [],
    };
  }

  const refById = new Map<string, BlockerRef>();
  const edgeKeys = new Set<string>();
  // [blocker, dependent] pairs over the walked subgraph (dependent may be the root)
  const edges: [string, string][] = [];
  const problems: StackProblem[] = [];

  const blockedByMemo = new Map<string, BlockerRef[]>();
  const fetchBlockers = async (id: string): Promise<BlockerRef[] | null> => {
    const cached = blockedByMemo.get(id);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const refs = await deps.getBlockedBy(id);
      blockedByMemo.set(id, refs);
      return refs;
    } catch (err) {
      problems.push({
        issueId: id,
        kind: "lookup-failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  // DFS colors: absent = white, false = on current path (gray), true = done.
  const finished = new Map<string, boolean>();

  const visit = async (
    id: string,
    path: string[],
    refs: BlockerRef[],
  ): Promise<string[] | null> => {
    finished.set(id, false);
    for (const ref of refs) {
      if (refById.has(ref.id) === false) {
        refById.set(ref.id, ref);
      }
      const edgeKey = `${ref.id}\u0000${id}`;
      if (edgeKeys.has(edgeKey) === false) {
        edgeKeys.add(edgeKey);
        edges.push([ref.id, id]);
      }
      const state = finished.get(ref.id);
      if (state === false) {
        const start = path.indexOf(ref.id);
        return [...path.slice(start === -1 ? 0 : start), ref.id];
      }
      if (state === undefined) {
        const childRefs = await fetchBlockers(ref.id);
        if (childRefs === null) {
          finished.set(ref.id, true);
        } else {
          const found = await visit(ref.id, [...path, ref.id], childRefs);
          if (found !== null) {
            return found;
          }
        }
      }
    }
    finished.set(id, true);
    return null;
  };

  const cycle = await visit(issueId, [issueId], directBlockers);

  if (cycle !== null) {
    return {
      ok: false,
      directBlockers,
      mergeBranches: [],
      prBase: bareBase,
      unsatisfied: [],
      cycle,
      problems,
    };
  }

  // Classify every walked blocker node (everything except the root).
  const unsatisfied: string[] = [];
  const branchByNode = new Map<string, string>();
  for (const [id, ref] of refById) {
    // refById holds each node exactly once, so this loop is itself the
    // per-resolution memo for the record/phase lookups.
    let s: Satisfaction;
    try {
      s = await classify(ref, deps);
    } catch (err) {
      // Degrade like a child getBlockedBy failure — a visible parked problem,
      // not a throw onto the silent <resolve-error> path. Skip the push when
      // the walk already recorded this id (both lookups failing one outage).
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
      if (s.branch !== null) {
        branchByNode.set(id, s.branch);
      }
    } else if (s.state === "missing-branch") {
      problems.push({
        issueId: id,
        kind: "missing-branch",
        detail: `${id} is at the terminal gate with a PR but has no recorded branch`,
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

  const mergeBranches = topoOrder
    .filter((n) => branchByNode.has(n))
    .map((n) => branchByNode.get(n))
    .filter((b): b is string => b !== undefined);

  // PR base: nearest contributing blocker by BFS layer from the root, lowest
  // ticket number on ties — the direct-blocker diamond rule extended through
  // done/closed intermediates. Bare base only when nothing contributes at
  // all: falling back to base while gated ancestor branches exist would let
  // their unreviewed code merge through this PR's diff.
  const blockersOf = new Map<string, string[]>();
  for (const [blocker, dependent] of edges) {
    blockersOf.set(dependent, [...(blockersOf.get(dependent) ?? []), blocker]);
  }
  let prBase = bareBase;
  const visited = new Set<string>([issueId]);
  let frontier = [issueId];
  while (frontier.length > 0) {
    const layer = [...new Set(frontier.flatMap((id) => blockersOf.get(id) ?? []))].filter(
      (id) => visited.has(id) === false,
    );
    for (const id of layer) {
      visited.add(id);
    }
    const contributor = layer.filter((id) => branchByNode.has(id)).sort(compareTickets)[0];
    if (contributor !== undefined) {
      prBase = branchByNode.get(contributor) ?? bareBase;
      break;
    }
    frontier = layer;
  }

  return {
    ok: unsatisfied.length === 0 && problems.length === 0,
    directBlockers,
    mergeBranches,
    prBase,
    unsatisfied: unsatisfied.sort(compareTickets),
    cycle: null,
    problems,
  };
}

async function classify(ref: BlockerRef, deps: StackResolveDeps): Promise<Satisfaction> {
  const rec = deps.getPipelineRecord(ref.id);
  if (rec?.currentPhase === "done") {
    // Merged to base (or into a parent's branch — the lineage walk covers
    // that): the blocker itself has nothing left to contribute.
    return { state: "satisfied", branch: null };
  }
  if (ref.closed) {
    // Done/cancelled outside RQ, or auto-closed by its merged PR.
    return { state: "satisfied", branch: null };
  }
  // Without a record and PR the gate test can never pass — skip the tracker
  // call rather than spend one API call per untracked blocker per sweep.
  if (rec === null) {
    return { state: "unsatisfied" };
  }
  if (rec.prNumber === null) {
    return { state: "unsatisfied" };
  }
  // The tracker is authoritative for the gate test — the local phase cache
  // misses manual phase moves and webhook-less deployments.
  const phase = await deps.getTrackerPhase(ref.id);
  if (phase !== null && deps.terminalGates.has(phase)) {
    if (rec.branchName !== null) {
      return { state: "satisfied", branch: rec.branchName };
    }
    return { state: "missing-branch" };
  }
  return { state: "unsatisfied" };
}
