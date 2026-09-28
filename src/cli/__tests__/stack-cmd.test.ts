import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCliContext } from "../context.js";
import { CliError } from "../errors.js";
import { cmdStack } from "../stack.js";

vi.mock("../context.js", () => ({ loadCliContext: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stack setup exit codes", () => {
  it("reports a context failure as an error, not as the conflict exit code", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.mocked(loadCliContext).mockImplementation(() => {
      throw new Error('Pipeline state is keyed to repo "old"');
    });

    const failure = await cmdStack(["setup", "ISSUE-1"]).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).exitCode).toBe(1);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      status: "error",
      message: 'Pipeline state is keyed to repo "old"',
    });
  });
});
