import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import type { AuditLogger } from "../audit.js";
import { buildPhaseGraph } from "../config.js";
import { SCHEMA_SQL } from "../database.js";
import { DEFAULT_PHASES } from "../defaults.js";
import { PipelineStateStore } from "../pipeline-state.js";
import { autoTransitionRework } from "../rework-transition.js";
import { MockIssueTracker } from "./fixtures/mock-adapters.js";

const silentAudit: AuditLogger = {
  log: () => undefined,
  query: () => [],
  prune: () => 0,
};

describe("autoTransitionRework in-scope PR guard", () => {
  const phaseGraph = buildPhaseGraph(DEFAULT_PHASES);
  let db: BetterSqlite3.Database;
  let pipelineState: PipelineStateStore;
  let issueTracker: MockIssueTracker;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    pipelineState = new PipelineStateStore(db, ["api", "web"]);
    issueTracker = new MockIssueTracker();
  });

  afterEach(() => {
    db.close();
  });

  it.each([
    {
      currentPhase: "human-review",
      targetPhase: "code-feedback",
      webInScope: true,
      expected: "transitioned",
    },
    {
      currentPhase: "human-review",
      targetPhase: "code-feedback",
      webInScope: false,
      expected: "skip",
    },
    {
      currentPhase: "spec-review",
      targetPhase: "spec-feedback",
      webInScope: true,
      expected: "skip",
    },
    {
      currentPhase: "spec-review",
      targetPhase: "spec-feedback",
      webInScope: false,
      expected: "transitioned",
    },
  ])(
    "$targetPhase returns $expected when only web has a PR and webInScope=$webInScope",
    async ({ currentPhase, targetPhase, webInScope, expected }) => {
      pipelineState.create("PROJ-1", currentPhase);
      pipelineState.setScope("PROJ-1", ["api", "web"]);
      pipelineState.updatePrNumber("PROJ-1", "web", 5, "main");
      if (webInScope === false) {
        pipelineState.setScope("PROJ-1", ["api"]);
      }
      issueTracker.phases.set("PROJ-1", currentPhase);
      expect(pipelineState.get("PROJ-1")?.prNumber).toBeNull();

      const result = await autoTransitionRework(
        { issueTracker, pipelineState, phaseGraph, audit: silentAudit },
        "PROJ-1",
        currentPhase,
        targetPhase,
        "test",
        {},
      );

      expect(result).toBe(expected);
      if (expected === "transitioned") {
        expect(issueTracker.calls).toEqual([`setPhase:PROJ-1:${targetPhase}`, "assignToAi:PROJ-1"]);
        expect(pipelineState.get("PROJ-1")?.currentPhase).toBe(targetPhase);
      } else {
        expect(issueTracker.calls).toEqual([]);
        expect(pipelineState.get("PROJ-1")?.currentPhase).toBe(currentPhase);
      }
    },
  );
});
