import { describe, it, expect } from "vitest";
import { AuthError } from "../../../http/retry.js";
import { PatAuthStrategy } from "../pat-strategy.js";

type FetchFn = typeof fetch;

function makeResponse(status: number, bodyJson: unknown): Response {
  return new Response(JSON.stringify(bodyJson), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PatAuthStrategy", () => {
  it("returns the static token", async () => {
    const strategy = new PatAuthStrategy({
      token: "abc",
      fetchImpl: (() => {
        throw new Error("should not be called");
      }) as FetchFn,
    });
    expect(await strategy.getToken()).toBe("abc");
  });

  it("fetches identity once and caches", async () => {
    let calls = 0;
    const fetchImpl: FetchFn = (() => {
      calls++;
      return Promise.resolve(makeResponse(200, { login: "octocat", id: 123, type: "User" }));
    }) as FetchFn;
    const strategy = new PatAuthStrategy({ token: "abc", fetchImpl });
    const id1 = await strategy.getIdentity();
    const id2 = await strategy.getIdentity();
    expect(id1).toEqual({ login: "octocat", accountId: "123", isBot: false });
    expect(id2).toEqual(id1);
    expect(calls).toBe(1);
  });

  it("marks Bot type as isBot", async () => {
    const fetchImpl: FetchFn = (() =>
      Promise.resolve(makeResponse(200, { login: "mybot", id: 999, type: "Bot" }))) as FetchFn;
    const strategy = new PatAuthStrategy({ token: "abc", fetchImpl });
    const id = await strategy.getIdentity();
    expect(id.isBot).toBe(true);
  });

  it("throws AuthError on 401", async () => {
    const fetchImpl: FetchFn = (() =>
      Promise.resolve(makeResponse(401, { message: "Bad credentials" }))) as FetchFn;
    const strategy = new PatAuthStrategy({ token: "abc", fetchImpl });
    await expect(strategy.getIdentity()).rejects.toBeInstanceOf(AuthError);
  });

  it("throws on empty token", () => {
    expect(() => new PatAuthStrategy({ token: "" })).toThrow();
  });
});
