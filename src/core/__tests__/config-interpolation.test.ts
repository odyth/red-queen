import { describe, it, expect } from "vitest";
import { ConfigError, interpolateEnv } from "../config.js";

describe("interpolateEnv", () => {
  it("replaces ${VAR} with env value", () => {
    const result = interpolateEnv("token: ${MY_TOKEN}", { MY_TOKEN: "secret" });
    expect(result).toBe("token: secret");
  });

  it("leaves $VAR without braces alone", () => {
    const result = interpolateEnv("cost: $5.99", {});
    expect(result).toBe("cost: $5.99");
  });

  it("throws ConfigError on unresolved variable", () => {
    expect(() => interpolateEnv("t: ${MISSING}", {})).toThrow(ConfigError);
  });

  it("lists multiple unresolved variables in single error", () => {
    let err: unknown = null;
    try {
      interpolateEnv("a: ${A}\nb: ${B}", {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const message = (err as Error).message;
    expect(message).toContain("$A");
    expect(message).toContain("$B");
  });

  it("handles multiple references to same variable", () => {
    const result = interpolateEnv("a: ${T}\nb: ${T}", { T: "x" });
    expect(result).toBe("a: x\nb: x");
  });

  it("matches only uppercase/underscore variable names", () => {
    // lowercase and mixed case should not match
    const result = interpolateEnv("${lowercase} ${MixedCase}", { lowercase: "a", MixedCase: "b" });
    expect(result).toBe("${lowercase} ${MixedCase}");
  });
});
