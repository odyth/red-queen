import { describe, it, expect } from "vitest";
import { pickLatestReview } from "../pr.js";
import type { Review } from "../../integrations/source-control.js";

function rev(overrides: Partial<Review> = {}): Review {
  return { id: "1", author: "bot", body: "", state: "COMMENTED", submittedAt: "", ...overrides };
}

describe("pickLatestReview", () => {
  it("returns null for an empty list", () => {
    expect(pickLatestReview([])).toBeNull();
  });

  it("picks the review with the most recent submittedAt", () => {
    const reviews = [
      rev({ id: "1", submittedAt: "2026-01-01T00:00:00Z" }),
      rev({ id: "3", submittedAt: "2026-01-03T00:00:00Z", body: "newest" }),
      rev({ id: "2", submittedAt: "2026-01-02T00:00:00Z" }),
    ];
    const latest = pickLatestReview(reviews);
    expect(latest?.id).toBe("3");
    expect(latest?.body).toBe("newest");
  });

  it("breaks submittedAt ties by insertion order (last wins)", () => {
    const reviews = [
      rev({ id: "1", submittedAt: "2026-01-01T00:00:00Z" }),
      rev({ id: "2", submittedAt: "2026-01-01T00:00:00Z", body: "later" }),
    ];
    expect(pickLatestReview(reviews)?.id).toBe("2");
  });

  it("ignores an unsubmitted review when a submitted one exists", () => {
    const reviews = [
      rev({ id: "1", submittedAt: "2026-01-01T00:00:00Z", body: "real" }),
      rev({ id: "2", submittedAt: "", body: "pending" }),
    ];
    expect(pickLatestReview(reviews)?.id).toBe("1");
  });
});
