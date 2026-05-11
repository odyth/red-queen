import { describe, expect, it } from "vitest";
import { COST_MARKER, findCost, formatCostBody } from "../cost-marker.js";

describe("cost-marker", () => {
  it("findCost returns null when no marker comment exists", () => {
    const lookup = findCost([{ id: 1, body: "some unrelated comment", created_at: "2026-01-01" }]);
    expect(lookup.content).toBeNull();
    expect(lookup.markerCommentId).toBeNull();
    expect(lookup.duplicateCount).toBe(0);
  });

  it("findCost returns the most recent marker comment and counts duplicates", () => {
    const lookup = findCost([
      { id: 1, body: `${COST_MARKER}\nold data`, created_at: "2026-01-01T00:00:00Z" },
      { id: 3, body: `${COST_MARKER}\nnewer data`, created_at: "2026-03-01T00:00:00Z" },
      { id: 2, body: "unrelated", created_at: "2026-02-01T00:00:00Z" },
    ]);
    expect(lookup.markerCommentId).toBe(3);
    expect(lookup.content).toBe("newer data");
    expect(lookup.duplicateCount).toBe(1);
  });

  it("formatCostBody prefixes marker and preserves body", () => {
    const body = formatCostBody("| Phase | Cost |\n| --- | --- |");
    expect(body.startsWith(COST_MARKER)).toBe(true);
    expect(body).toContain("| Phase | Cost |");
  });
});
