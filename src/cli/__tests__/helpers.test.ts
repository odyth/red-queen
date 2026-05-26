import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { cmdIssue } from "../issue.js";
import { cmdPipeline } from "../pipeline.js";
import { cmdPr } from "../pr.js";
import { cmdSpec } from "../spec.js";
import { cmdSubIter } from "../sub-iter.js";

// Run `fn` with process.stdin temporarily replaced by a readable yielding `text`,
// so we can exercise the `--*-stdin` CLI paths without a real pipe.
async function withStdin(text: string, fn: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, "stdin");
  const fake = Readable.from([Buffer.from(text, "utf8")]) as unknown as NodeJS.ReadStream;
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  try {
    await fn();
  } finally {
    if (original !== undefined) {
      Object.defineProperty(process, "stdin", original);
    }
  }
}

let tmp: string;
let originalCwd: string;
let originalWrite: typeof process.stdout.write;
let stdoutCapture: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rq-helpers-"));
  originalCwd = process.cwd();
  execSync("git init -q", { cwd: tmp });
  execSync("git config user.email test@example.com", { cwd: tmp });
  execSync("git config user.name Test", { cwd: tmp });
  writeFileSync(
    join(tmp, "redqueen.yaml"),
    [
      "issueTracker:",
      "  type: mock",
      "sourceControl:",
      "  type: mock",
      "project:",
      "  buildCommand: echo",
      "  testCommand: echo",
      "  directory: .",
      "",
    ].join("\n"),
  );
  process.chdir(tmp);

  stdoutCapture = [];
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutCapture.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = originalWrite;
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("cmdIssue get", () => {
  it("prints the mock issue JSON", async () => {
    await cmdIssue(["get", "ISSUE-1"]);
    const out = stdoutCapture.join("");
    const parsed = JSON.parse(out) as { id: string; issueType: string };
    expect(parsed.id).toBe("ISSUE-1");
    expect(parsed.issueType).toBe("feature");
  });
});

describe("cmdPipeline update + cleanup", () => {
  it("creates and updates pipeline state", async () => {
    await cmdPipeline(["update", "ISSUE-1", "--branch", "feature/ISSUE-1", "--pr", "42"]);
    const out = stdoutCapture.join("");
    const parsed = JSON.parse(out) as { branchName: string; prNumber: number };
    expect(parsed.branchName).toBe("feature/ISSUE-1");
    expect(parsed.prNumber).toBe(42);
  });

  it("cleanup clears worktree path", async () => {
    await cmdPipeline(["update", "ISSUE-2", "--worktree", "/tmp/fake-worktree"]);
    stdoutCapture = [];
    await cmdPipeline(["cleanup", "ISSUE-2"]);
    const out = stdoutCapture.join("");
    const parsed = JSON.parse(out) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });
});

describe("cmdPr create", () => {
  it("creates a PR and writes the number into pipeline state", async () => {
    await cmdPr([
      "create",
      "--issue",
      "ISSUE-1",
      "--head",
      "feature/ISSUE-1",
      "--base",
      "main",
      "--title",
      "test",
      "--body",
      "body",
    ]);
    const out = stdoutCapture.join("");
    const parsed = JSON.parse(out) as { number: number; headBranch: string };
    expect(parsed.number).toBe(1);
    expect(parsed.headBranch).toBe("feature/ISSUE-1");

    // Verify pipeline state got updated.
    stdoutCapture = [];
    await cmdPipeline(["update", "ISSUE-1"]);
    const state = JSON.parse(stdoutCapture.join("")) as {
      branchName: string;
      prNumber: number;
    };
    expect(state.branchName).toBe("feature/ISSUE-1");
    expect(state.prNumber).toBe(1);
  });
});

describe("cmdPr review via --body", () => {
  it("accepts the verdict flag", async () => {
    await cmdPr(["review", "1", "--verdict", "approve", "--body", "LGTM"]);
    const out = stdoutCapture.join("");
    const parsed = JSON.parse(out) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it("rejects an invalid verdict", async () => {
    await expect(cmdPr(["review", "1", "--verdict", "hmm", "--body", "x"])).rejects.toThrow(
      /verdict/,
    );
  });
});

describe("cmdSubIter start", () => {
  it("opens a new sub-iteration entry against the current phase", async () => {
    await cmdPipeline(["update", "SUB-1"]);
    stdoutCapture = [];
    // Seed currentPhase via the pipeline_state row — the CLI doesn't accept
    // it as a flag (it reads from pipeline state to keep the skill ergonomic).
    const { loadCliContext } = await import("../context.js");
    const ctx = loadCliContext();
    ctx.pipelineState.updatePhase("SUB-1", "spec-writing");
    ctx.cleanup();

    await cmdSubIter(["start", "SUB-1", "Codebase research"]);
    const parsed = JSON.parse(stdoutCapture.join("")) as {
      issueId: string;
      phaseName: string;
      subIterIndex: number;
      label: string;
      status: string;
    };
    expect(parsed.issueId).toBe("SUB-1");
    expect(parsed.phaseName).toBe("spec-writing");
    expect(parsed.subIterIndex).toBe(0);
    expect(parsed.label).toBe("Codebase research");
    expect(parsed.status).toBe("in-progress");
  });

  it("errors when no pipeline record exists", async () => {
    await expect(cmdSubIter(["start", "SUB-MISSING", "label"])).rejects.toThrow(
      /no pipeline record/,
    );
  });

  it("errors when the pipeline record has no current phase", async () => {
    await cmdPipeline(["update", "SUB-NOPHASE"]);
    await expect(cmdSubIter(["start", "SUB-NOPHASE", "label"])).rejects.toThrow(/no current phase/);
  });

  it("errors without an issueId", async () => {
    await expect(cmdSubIter(["start"])).rejects.toThrow(/issueId/);
  });

  it("errors without a label", async () => {
    await cmdPipeline(["update", "SUB-2"]);
    await expect(cmdSubIter(["start", "SUB-2"])).rejects.toThrow(/label/);
  });
});

describe("cmdSubIter complete", () => {
  it("closes the most recent open sub-iteration with a summary", async () => {
    await cmdPipeline(["update", "SUB-3"]);
    const { loadCliContext } = await import("../context.js");
    const ctx = loadCliContext();
    ctx.pipelineState.updatePhase("SUB-3", "spec-writing");
    ctx.cleanup();

    await cmdSubIter(["start", "SUB-3", "Codebase research"]);
    stdoutCapture = [];
    await cmdSubIter(["complete", "SUB-3", "--summary", "Picked module X"]);
    const parsed = JSON.parse(stdoutCapture.join("")) as {
      status: string;
      summary: string;
      label: string;
    };
    expect(parsed.status).toBe("completed");
    expect(parsed.summary).toBe("Picked module X");
    expect(parsed.label).toBe("Codebase research");
  });

  it("errors when no open sub-iteration exists", async () => {
    await cmdPipeline(["update", "SUB-NONE"]);
    const { loadCliContext } = await import("../context.js");
    const ctx = loadCliContext();
    ctx.pipelineState.updatePhase("SUB-NONE", "spec-writing");
    ctx.cleanup();

    await expect(cmdSubIter(["complete", "SUB-NONE", "--summary", "x"])).rejects.toThrow(
      /no open sub-iteration/,
    );
  });

  it("errors without --summary", async () => {
    await cmdPipeline(["update", "SUB-4"]);
    await expect(cmdSubIter(["complete", "SUB-4"])).rejects.toThrow(/summary/);
  });

  it("accepts --summary-stdin", async () => {
    await cmdPipeline(["update", "SUB-5"]);
    const { loadCliContext } = await import("../context.js");
    const ctx = loadCliContext();
    ctx.pipelineState.updatePhase("SUB-5", "spec-research");
    ctx.cleanup();

    await cmdSubIter(["start", "SUB-5", "Codebase research"]);
    stdoutCapture = [];
    await withStdin("multi\nline\nfindings", () =>
      cmdSubIter(["complete", "SUB-5", "--summary-stdin"]),
    );
    const parsed = JSON.parse(stdoutCapture.join("")) as { status: string; summary: string };
    expect(parsed.status).toBe("completed");
    expect(parsed.summary).toBe("multi\nline\nfindings");
  });
});

describe("cmdSubIter latest", () => {
  it("returns the most recent completed entry for a phase", async () => {
    await cmdPipeline(["update", "LAT-1"]);
    const { loadCliContext } = await import("../context.js");
    const ctx = loadCliContext();
    ctx.pipelineState.updatePhase("LAT-1", "spec-research");
    ctx.cleanup();

    await cmdSubIter(["start", "LAT-1", "Codebase research"]);
    await cmdSubIter(["complete", "LAT-1", "--summary", "findings here"]);
    stdoutCapture = [];
    await cmdSubIter(["latest", "LAT-1", "--phase", "spec-research"]);
    const parsed = JSON.parse(stdoutCapture.join("")) as { summary: string; phaseName: string };
    expect(parsed.summary).toBe("findings here");
    expect(parsed.phaseName).toBe("spec-research");
  });

  it("writes null when no completed entry exists", async () => {
    await cmdPipeline(["update", "LAT-2"]);
    stdoutCapture = [];
    await cmdSubIter(["latest", "LAT-2", "--phase", "spec-research"]);
    expect(stdoutCapture.join("").trim()).toBe("null");
  });

  it("errors without --phase", async () => {
    await expect(cmdSubIter(["latest", "LAT-3"])).rejects.toThrow(/phase/);
  });
});

describe("cmdPipeline get", () => {
  it("returns the full record including the new metadata columns", async () => {
    await cmdPipeline(["update", "GET-1", "--branch", "feature/GET-1"]);
    stdoutCapture = [];
    await cmdPipeline(["get", "GET-1"]);
    const parsed = JSON.parse(stdoutCapture.join("")) as {
      issueId: string;
      branchName: string;
      openQuestionCount: number | null;
      parsedOpenQuestionCount: number | null;
      lastAiSpecHash: string | null;
    };
    expect(parsed.issueId).toBe("GET-1");
    expect(parsed.branchName).toBe("feature/GET-1");
    expect(parsed.openQuestionCount).toBeNull();
    expect(parsed.parsedOpenQuestionCount).toBeNull();
    expect(parsed.lastAiSpecHash).toBeNull();
  });

  it("errors when no record exists", async () => {
    await expect(cmdPipeline(["get", "NOPE"])).rejects.toThrow(/no pipeline record/);
  });
});

describe("cmdSpec meta + set", () => {
  it("meta writes open_question_count", async () => {
    await cmdPipeline(["update", "SPEC-1"]);
    stdoutCapture = [];
    await cmdSpec(["meta", "SPEC-1", "--open-questions", "3"]);
    const out = JSON.parse(stdoutCapture.join("")) as { ok: boolean; openQuestionCount: number };
    expect(out.ok).toBe(true);
    expect(out.openQuestionCount).toBe(3);

    stdoutCapture = [];
    await cmdPipeline(["get", "SPEC-1"]);
    const rec = JSON.parse(stdoutCapture.join("")) as { openQuestionCount: number };
    expect(rec.openQuestionCount).toBe(3);
  });

  it("meta requires at least one flag", async () => {
    await cmdPipeline(["update", "SPEC-2"]);
    await expect(cmdSpec(["meta", "SPEC-2"])).rejects.toThrow(/at least one/);
  });

  it("set parses the Open Questions section and records hash + timestamp", async () => {
    await cmdPipeline(["update", "SPEC-3"]);
    const body = "# Spec\n\n## Open Questions\n\n- [ ] one\n- [ ] two\n- [x] done\n";
    stdoutCapture = [];
    await cmdSpec(["set", "SPEC-3", "--body", body]);
    const setOut = JSON.parse(stdoutCapture.join("")) as {
      ok: boolean;
      parsedOpenQuestionCount: number;
    };
    expect(setOut.parsedOpenQuestionCount).toBe(2);

    stdoutCapture = [];
    await cmdPipeline(["get", "SPEC-3"]);
    const rec = JSON.parse(stdoutCapture.join("")) as {
      specContent: string;
      parsedOpenQuestionCount: number;
      lastAiSpecHash: string | null;
      lastAiSpecAt: string | null;
    };
    expect(rec.specContent).toBe(body);
    expect(rec.parsedOpenQuestionCount).toBe(2);
    expect(rec.lastAiSpecHash).not.toBeNull();
    expect(rec.lastAiSpecAt).not.toBeNull();
  });

  it("meta rejects non-integer counts", async () => {
    await cmdPipeline(["update", "SPEC-4"]);
    await expect(cmdSpec(["meta", "SPEC-4", "--open-questions", "3abc"])).rejects.toThrow(
      /non-negative integer/,
    );
    await expect(cmdSpec(["meta", "SPEC-4", "--open-questions", "3.9"])).rejects.toThrow(
      /non-negative integer/,
    );
  });

  it("set records null parsed count when no Open Questions section is found", async () => {
    await cmdPipeline(["update", "SPEC-5"]);
    // Decorated heading the strict regex skips → no section found → null, not 0,
    // so the orchestrator treats it as "unknown" and won't auto-skip the gate.
    const body = "# Spec\n\n## Open Questions (2)\n\n- [ ] unresolved\n";
    stdoutCapture = [];
    await cmdSpec(["set", "SPEC-5", "--body", body]);
    const setOut = JSON.parse(stdoutCapture.join("")) as {
      parsedOpenQuestionCount: number | null;
    };
    expect(setOut.parsedOpenQuestionCount).toBeNull();
  });
});

describe("cmdPr comments", () => {
  it("emits flat JSON when --threads is absent", async () => {
    await cmdPr(["comments", "1"]);
    const out = stdoutCapture.join("");
    const parsed = JSON.parse(out) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("emits threads JSON when --threads is set", async () => {
    await cmdPr(["comments", "1", "--threads"]);
    const out = stdoutCapture.join("");
    const parsed = JSON.parse(out) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
  });
});
