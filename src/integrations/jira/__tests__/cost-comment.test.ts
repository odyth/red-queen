import { describe, expect, it } from "vitest";
import { findCostComment, JIRA_COST_MARKER } from "../cost-comment.js";
import type { RawJiraComment } from "../cost-comment.js";
import { renderBreakdownAdf } from "../cost-adf.js";
import type { CostBreakdown } from "../../../core/types.js";

const breakdown: CostBreakdown = {
  totalCostUsd: 1.23,
  model: "opus",
  currency: "USD",
  phases: [],
  updatedAt: "2026-05-29T00:00:00Z",
};

function humanComment(id: string, text: string, created: string): RawJiraComment {
  return {
    id,
    created,
    body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  };
}

function costComment(id: string, created: string): RawJiraComment {
  return { id, created, body: renderBreakdownAdf(breakdown) };
}

describe("findCostComment", () => {
  it("returns null when no comment carries the marker", () => {
    const found = findCostComment([
      humanComment("1", "looks good to me", "2026-05-01T00:00:00Z"),
      humanComment("2", "ship it", "2026-05-02T00:00:00Z"),
    ]);
    expect(found.commentId).toBeNull();
    expect(found.duplicateCount).toBe(0);
  });

  it("matches a comment rendered by renderBreakdownAdf", () => {
    const found = findCostComment([
      humanComment("1", "unrelated", "2026-05-01T00:00:00Z"),
      costComment("99", "2026-05-02T00:00:00Z"),
    ]);
    expect(found.commentId).toBe("99");
    expect(found.duplicateCount).toBe(0);
  });

  it("keeps the newest and reports the rest as duplicate ids", () => {
    const found = findCostComment([
      costComment("old", "2026-05-01T00:00:00Z"),
      costComment("new", "2026-05-10T00:00:00Z"),
      costComment("mid", "2026-05-05T00:00:00Z"),
    ]);
    expect(found.commentId).toBe("new");
    expect(found.duplicateCount).toBe(2);
    expect([...found.duplicateIds].sort()).toEqual(["mid", "old"]);
  });

  it("does not match when the marker is not at the start of the comment", () => {
    const found = findCostComment([
      humanComment("1", `quoting you: ${JIRA_COST_MARKER} (model: opus)`, "2026-05-01T00:00:00Z"),
    ]);
    expect(found.commentId).toBeNull();
  });

  it("does not match a human comment that only opens with the marker phrase", () => {
    const found = findCostComment([
      humanComment("1", `${JIRA_COST_MARKER} looks high this sprint`, "2026-05-01T00:00:00Z"),
    ]);
    expect(found.commentId).toBeNull();
  });
});
