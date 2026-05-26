import { describe, it, expect } from "vitest";
import { computeHumanModifiedSpec, normalizeSpec, sha256Hex } from "../strings.js";

describe("normalizeSpec", () => {
  it("strips trailing whitespace per line", () => {
    expect(normalizeSpec("a   \nb\t\nc")).toBe("a\nb\nc");
  });

  it("strips leading and trailing blank lines", () => {
    expect(normalizeSpec("\n\n# Title\n\nbody\n\n\n")).toBe("# Title\n\nbody");
  });

  it("preserves interior blank lines", () => {
    expect(normalizeSpec("a\n\n\nb")).toBe("a\n\n\nb");
  });

  it("is idempotent", () => {
    const once = normalizeSpec("  x  \n\n y \n");
    expect(normalizeSpec(once)).toBe(once);
  });
});

describe("sha256Hex", () => {
  it("hashes identical inputs identically", () => {
    expect(sha256Hex("hello")).toBe(sha256Hex("hello"));
  });

  it("hashes byte-different inputs differently", () => {
    expect(sha256Hex("hello")).not.toBe(sha256Hex("hellp"));
  });

  it("treats cosmetic-only differences as identical after normalization", () => {
    expect(sha256Hex(normalizeSpec("# Spec\nbody  "))).toBe(
      sha256Hex(normalizeSpec("\n# Spec\nbody\n")),
    );
  });
});

describe("computeHumanModifiedSpec", () => {
  it("returns false for null spec content regardless of lastAiSpecHash", () => {
    expect(computeHumanModifiedSpec(null, null)).toBe(false);
    expect(computeHumanModifiedSpec(null, "abc123")).toBe(false);
  });

  it("returns false for whitespace-only spec content regardless of lastAiSpecHash", () => {
    expect(computeHumanModifiedSpec("   \n\t\n", null)).toBe(false);
    expect(computeHumanModifiedSpec("   \n\t\n", "abc123")).toBe(false);
  });

  it("returns true when spec is non-empty and lastAiSpecHash is null (human pre-populated)", () => {
    expect(computeHumanModifiedSpec("# Spec\nbody", null)).toBe(true);
  });

  it("returns false when the current normalized hash matches lastAiSpecHash", () => {
    const body = "# Spec\nbody";
    const hash = sha256Hex(normalizeSpec(body));
    expect(computeHumanModifiedSpec(body, hash)).toBe(false);
  });

  it("returns false for cosmetic-only edits that survive normalization", () => {
    const hash = sha256Hex(normalizeSpec("# Spec\nbody"));
    expect(computeHumanModifiedSpec("# Spec\nbody   \n", hash)).toBe(false);
  });

  it("returns true when the hashes diverge (substantive human edit)", () => {
    const hash = sha256Hex(normalizeSpec("# Spec\nbody"));
    expect(computeHumanModifiedSpec("# Spec\nEDITED body", hash)).toBe(true);
  });
});
