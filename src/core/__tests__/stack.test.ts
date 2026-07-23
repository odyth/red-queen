import { describe, it, expect } from "vitest";
import { resolveStack, terminalGateNames, ticketNumber } from "../stack.js";
import type { StackResolveDeps } from "../stack.js";
import { PhaseGraph } from "../types.js";
import type { PipelineRecord } from "../types.js";
import { DEFAULT_PHASES } from "../defaults.js";
import type { BlockerRef } from "../../integrations/issue-tracker.js";

function record(issueId: string, overrides: Partial<PipelineRecord> = {}): PipelineRecord {
  return {
    issueId,
    currentPhase: "coding",
    priorPhase: null,
    branchName: null,
    prNumber: null,
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
}

interface Harness {
  deps: StackResolveDeps;
  blockedBy: Map<string, BlockerRef[]>;
  records: Map<string, PipelineRecord>;
  phases: Map<string, string>;
  throwsFor: Set<string>;
  phaseCalls: string[];
}

function mkDeps(): Harness {
  const blockedBy = new Map<string, BlockerRef[]>();
  const records = new Map<string, PipelineRecord>();
  const phases = new Map<string, string>();
  const throwsFor = new Set<string>();
  const phaseCalls: string[] = [];
  const deps: StackResolveDeps = {
    getBlockedBy: (id) =>
      throwsFor.has(id)
        ? Promise.reject(new Error(`lookup boom for ${id}`))
        : Promise.resolve(blockedBy.get(id) ?? []),
    getPipelineRecord: (id) => records.get(id) ?? null,
    getTrackerPhase: (id) => {
      phaseCalls.push(id);
      return Promise.resolve(phases.get(id) ?? null);
    },
    terminalGates: new Set(["human-review"]),
  };
  return { deps, blockedBy, records, phases, throwsFor, phaseCalls };
}

// Shorthand: a blocker parked at the terminal gate with PR + branch.
function atGate(h: Harness, id: string, branch: string): void {
  h.records.set(id, record(id, { currentPhase: "human-review", prNumber: 10, branchName: branch }));
  h.phases.set(id, "human-review");
}

describe("terminalGateNames", () => {
  it("keeps only human gates that exit to done", () => {
    const gates = terminalGateNames(new PhaseGraph(DEFAULT_PHASES));
    expect(gates).toEqual(new Set(["human-review"]));
  });
});

describe("ticketNumber", () => {
  it("parses trailing digits across id formats", () => {
    expect(ticketNumber("PROJ-123")).toBe(123);
    expect(ticketNumber("#45")).toBe(45);
    expect(ticketNumber("owner/repo#7")).toBe(7);
  });

  it("sorts ids without digits last", () => {
    expect(ticketNumber("no-digits")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("resolveStack", () => {
  const BASE = "main";

  it("no blockers → trivially ok on bare base", async () => {
    const h = mkDeps();
    const r = await resolveStack("#1", BASE, h.deps);
    expect(r).toEqual({
      ok: true,
      directBlockers: [],
      mergeBranches: [],
      prBase: BASE,
      unsatisfied: [],
      cycle: null,
      problems: [],
    });
  });

  it("blocker done locally → satisfied, no branch, no tracker call", async () => {
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.records.set("#1", record("#1", { currentPhase: "done", branchName: "feature/1" }));

    const r = await resolveStack("#2", BASE, h.deps);
    expect(r.ok).toBe(true);
    expect(r.mergeBranches).toEqual([]);
    expect(r.prBase).toBe(BASE);
    expect(h.phaseCalls).toEqual([]);
  });

  it("blocker closed on the tracker with no record → satisfied (closed-fallback)", async () => {
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "#1", closed: true }]);

    const r = await resolveStack("#2", BASE, h.deps);
    expect(r.ok).toBe(true);
    expect(r.mergeBranches).toEqual([]);
    expect(h.phaseCalls).toEqual([]);
  });

  it("blocker at gate with PR and branch → satisfied, contributes branch, becomes prBase", async () => {
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    atGate(h, "#1", "feature/1");

    const r = await resolveStack("#2", BASE, h.deps);
    expect(r.ok).toBe(true);
    expect(r.mergeBranches).toEqual(["feature/1"]);
    expect(r.prBase).toBe("feature/1");
  });

  it("blocker at gate with PR but no branch → missing-branch problem", async () => {
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.records.set("#1", record("#1", { currentPhase: "human-review", prNumber: 5 }));
    h.phases.set("#1", "human-review");

    const r = await resolveStack("#2", BASE, h.deps);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.issueId).toBe("#1");
    expect(r.problems[0]?.kind).toBe("missing-branch");
  });

  it("blocker at gate without a PR → unsatisfied", async () => {
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.records.set("#1", record("#1", { currentPhase: "human-review", branchName: "feature/1" }));
    h.phases.set("#1", "human-review");

    const r = await resolveStack("#2", BASE, h.deps);
    expect(r.ok).toBe(false);
    expect(r.unsatisfied).toEqual(["#1"]);
  });

  it("recordless open blocker → unsatisfied without a tracker phase call", async () => {
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);

    const r = await resolveStack("#2", BASE, h.deps);
    expect(r.ok).toBe(false);
    expect(r.unsatisfied).toEqual(["#1"]);
    expect(h.phaseCalls).toEqual([]);
  });

  it("blocker mid-pipeline → unsatisfied, tracker phase is authoritative", async () => {
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    // Local cache says gate, tracker says coding — tracker wins.
    h.records.set(
      "#1",
      record("#1", { currentPhase: "human-review", prNumber: 5, branchName: "feature/1" }),
    );
    h.phases.set("#1", "coding");

    const r = await resolveStack("#2", BASE, h.deps);
    expect(r.ok).toBe(false);
    expect(r.unsatisfied).toEqual(["#1"]);
  });

  it("diamond: topo order with ticket-number tie-break, prBase from lowest direct blocker", async () => {
    // A(#1, done) blocks C(#3), D(#4); C,D block E(#5); C,D,E block F(#6).
    const h = mkDeps();
    h.blockedBy.set("#6", [
      { id: "#5", closed: false },
      { id: "#4", closed: false },
      { id: "#3", closed: false },
    ]);
    h.blockedBy.set("#5", [
      { id: "#4", closed: false },
      { id: "#3", closed: false },
    ]);
    h.blockedBy.set("#3", [{ id: "#1", closed: false }]);
    h.blockedBy.set("#4", [{ id: "#1", closed: false }]);
    h.records.set("#1", record("#1", { currentPhase: "done" }));
    atGate(h, "#3", "feature/3");
    atGate(h, "#4", "feature/4");
    atGate(h, "#5", "feature/5");

    const r = await resolveStack("#6", BASE, h.deps);
    expect(r.ok).toBe(true);
    expect(r.mergeBranches).toEqual(["feature/3", "feature/4", "feature/5"]);
    expect(r.prBase).toBe("feature/3");
  });

  it("single direct blocker chain: prBase is the nearest blocker's branch", async () => {
    // A(#1, done) blocks C(#3), D(#4); C,D block E(#5); E blocks F(#6).
    const h = mkDeps();
    h.blockedBy.set("#6", [{ id: "#5", closed: false }]);
    h.blockedBy.set("#5", [
      { id: "#4", closed: false },
      { id: "#3", closed: false },
    ]);
    h.blockedBy.set("#3", [{ id: "#1", closed: false }]);
    h.blockedBy.set("#4", [{ id: "#1", closed: false }]);
    h.records.set("#1", record("#1", { currentPhase: "done" }));
    atGate(h, "#3", "feature/3");
    atGate(h, "#4", "feature/4");
    atGate(h, "#5", "feature/5");

    const r = await resolveStack("#6", BASE, h.deps);
    expect(r.ok).toBe(true);
    expect(r.mergeBranches).toEqual(["feature/3", "feature/4", "feature/5"]);
    expect(r.prBase).toBe("feature/5");
  });

  it("walks through done nodes: ancestor branch still reachable, PR targets it", async () => {
    // B(#2) blocked by A(#1, done); A blocked by Z(#9) at gate with a branch.
    // A merged into Z's branch, so B still needs Z's branch merged — and B's
    // PR must target it: a PR against bare base would present Z's still-gated
    // code as B's diff and make it mergeable past the human gate.
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.blockedBy.set("#1", [{ id: "#9", closed: false }]);
    h.records.set("#1", record("#1", { currentPhase: "done" }));
    atGate(h, "#9", "feature/9");

    const r = await resolveStack("#2", BASE, h.deps);
    expect(r.ok).toBe(true);
    expect(r.mergeBranches).toEqual(["feature/9"]);
    expect(r.prBase).toBe("feature/9");
  });

  it("prBase through a done intermediate: nearest layer wins, lowest ticket on ties", async () => {
    // B(#2) ← A(#1, done) ← C(#3, gate) + D(#4, gate): C and D tie at the
    // nearest contributing layer — lowest ticket wins, mirroring the
    // direct-blocker diamond rule.
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.blockedBy.set("#1", [
      { id: "#4", closed: false },
      { id: "#3", closed: false },
    ]);
    h.records.set("#1", record("#1", { currentPhase: "done" }));
    atGate(h, "#3", "feature/3");
    atGate(h, "#4", "feature/4");

    const r = await resolveStack("#2", BASE, h.deps);
    expect(r.ok).toBe(true);
    expect(r.mergeBranches).toEqual(["feature/3", "feature/4"]);
    expect(r.prBase).toBe("feature/3");
  });

  it("prBase prefers the nearest contributor over deeper ancestors", async () => {
    // B(#2) ← A(#1, done) ← Y(#8, gate) ← Z(#9, gate): Y's branch already
    // contains Z's (stacked build), so the PR targets Y — the smallest diff
    // that still keeps every gated ancestor behind a human-review gate.
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    h.blockedBy.set("#1", [{ id: "#8", closed: false }]);
    h.blockedBy.set("#8", [{ id: "#9", closed: false }]);
    h.records.set("#1", record("#1", { currentPhase: "done" }));
    atGate(h, "#8", "feature/8");
    atGate(h, "#9", "feature/9");

    const r = await resolveStack("#2", BASE, h.deps);
    expect(r.ok).toBe(true);
    expect(r.mergeBranches).toEqual(["feature/9", "feature/8"]);
    expect(r.prBase).toBe("feature/8");
  });

  it("self-link → cycle with path", async () => {
    const h = mkDeps();
    h.blockedBy.set("#1", [{ id: "#1", closed: false }]);

    const r = await resolveStack("#1", BASE, h.deps);
    expect(r.ok).toBe(false);
    expect(r.cycle).toEqual(["#1", "#1"]);
  });

  it("three-node cycle → full path captured", async () => {
    const h = mkDeps();
    h.blockedBy.set("#1", [{ id: "#2", closed: false }]);
    h.blockedBy.set("#2", [{ id: "#3", closed: false }]);
    h.blockedBy.set("#3", [{ id: "#1", closed: false }]);

    const r = await resolveStack("#1", BASE, h.deps);
    expect(r.ok).toBe(false);
    expect(r.cycle).toEqual(["#1", "#2", "#3", "#1"]);
  });

  it("all blockers merged → ok with bare base", async () => {
    const h = mkDeps();
    h.blockedBy.set("#3", [
      { id: "#1", closed: false },
      { id: "#2", closed: true },
    ]);
    h.records.set("#1", record("#1", { currentPhase: "done" }));

    const r = await resolveStack("#3", BASE, h.deps);
    expect(r.ok).toBe(true);
    expect(r.mergeBranches).toEqual([]);
    expect(r.prBase).toBe(BASE);
  });

  it("ancestor lookup failure → lookup-failed problem, parks", async () => {
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    atGate(h, "#1", "feature/1");
    h.throwsFor.add("#1");

    const r = await resolveStack("#2", BASE, h.deps);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.issueId).toBe("#1");
    expect(r.problems[0]?.kind).toBe("lookup-failed");
    expect(r.problems[0]?.detail).toContain("boom");
  });

  it("root lookup failure → rejects (caller defers with resolve-error)", async () => {
    const h = mkDeps();
    h.throwsFor.add("#1");
    await expect(resolveStack("#1", BASE, h.deps)).rejects.toThrow("lookup boom");
  });

  it("tracker phase failure during classify → lookup-failed problem, not a throw", async () => {
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    // prNumber present so classify reaches the phase lookup.
    h.records.set("#1", record("#1", { currentPhase: "coding", prNumber: 5 }));
    const throwingPhase: StackResolveDeps = {
      ...h.deps,
      getTrackerPhase: () => Promise.reject(new Error("phase boom")),
    };

    const r = await resolveStack("#2", BASE, throwingPhase);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.issueId).toBe("#1");
    expect(r.problems[0]?.kind).toBe("lookup-failed");
    expect(r.problems[0]?.detail).toContain("phase boom");
  });

  it("blocker failing both lookups yields a single problem entry", async () => {
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "#1", closed: false }]);
    atGate(h, "#1", "feature/1");
    h.throwsFor.add("#1");
    const throwingPhase: StackResolveDeps = {
      ...h.deps,
      getTrackerPhase: () => Promise.reject(new Error("phase boom")),
    };

    const r = await resolveStack("#2", BASE, throwingPhase);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.kind).toBe("lookup-failed");
  });

  it("memoizes getBlockedBy per resolution on shared ancestors", async () => {
    const h = mkDeps();
    let calls = 0;
    const counting: StackResolveDeps = {
      ...h.deps,
      getBlockedBy: (id) => {
        calls++;
        return Promise.resolve(h.blockedBy.get(id) ?? []);
      },
    };
    // Diamond where #1 is reachable via both #3 and #4.
    h.blockedBy.set("#5", [
      { id: "#3", closed: false },
      { id: "#4", closed: false },
    ]);
    h.blockedBy.set("#3", [{ id: "#1", closed: false }]);
    h.blockedBy.set("#4", [{ id: "#1", closed: false }]);
    h.records.set("#1", record("#1", { currentPhase: "done" }));
    atGate(h, "#3", "feature/3");
    atGate(h, "#4", "feature/4");

    await resolveStack("#5", BASE, counting);
    // Root + #3 + #4 + #1, each fetched once.
    expect(calls).toBe(4);
  });

  it("cross-repo blocker without a record follows the closed-fallback rule", async () => {
    const h = mkDeps();
    h.blockedBy.set("#2", [{ id: "other/repo#7", closed: false }]);

    const open = await resolveStack("#2", BASE, h.deps);
    expect(open.ok).toBe(false);
    expect(open.unsatisfied).toEqual(["other/repo#7"]);

    h.blockedBy.set("#2", [{ id: "other/repo#7", closed: true }]);
    const closed = await resolveStack("#2", BASE, h.deps);
    expect(closed.ok).toBe(true);
  });
});
