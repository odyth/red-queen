import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DualWriteAuditLogger } from "../../core/audit.js";
import { buildPhaseGraph } from "../../core/config.js";
import { SCHEMA_SQL } from "../../core/database.js";
import { DEFAULT_PHASES } from "../../core/defaults.js";
import { OrchestratorStateStore } from "../../core/pipeline-state.js";
import { SqliteTaskQueue } from "../../core/queue.js";
import { RuntimeState } from "../../core/runtime-state.js";
import { makeTestConfig } from "../../core/__tests__/fixtures/test-config.js";
import { DashboardServer } from "../server.js";

let db: BetterSqlite3.Database;
let tempDir: string;
let server: DashboardServer;
let port: number;
let runtime: RuntimeState;

async function getFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolvePort) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr !== null ? addr.port : 0;
      s.close(() => {
        resolvePort(p);
      });
    });
  });
}

function writeSkill(dir: string, name: string, body: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), body, "utf8");
}

describe("Dashboard skills API", () => {
  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "rq-skills-api-"));
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    const queue = new SqliteTaskQueue(db);
    const orchestratorState = new OrchestratorStateStore(db);
    const audit = new DualWriteAuditLogger(db, join(tempDir, "audit.log"));

    const bundledDir = join(tempDir, "bundled-skills");
    const userDir = join(tempDir, ".redqueen", "skills");
    mkdirSync(bundledDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
    writeSkill(bundledDir, "coder", "# bundled coder\n");
    writeSkill(bundledDir, "reviewer", "# bundled reviewer\n");
    writeSkill(userDir, "coder", "# user coder override\n");
    writeSkill(userDir, "custom", "# user-only skill\n");

    runtime = new RuntimeState(
      buildPhaseGraph(DEFAULT_PHASES),
      makeTestConfig({ phases: DEFAULT_PHASES }),
    );
    port = await getFreePort();
    server = new DashboardServer(
      {
        queue,
        orchestratorState,
        audit,
        editor: {
          runtime,
          configPath: join(tempDir, "redqueen.yaml"),
          projectRoot: tempDir,
          builtInSkillsDir: bundledDir,
          reload: () => ({ applied: [], restartRequired: [] }),
        },
      },
      { host: "127.0.0.1", port, enableDashboardUi: true },
    );
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("GET /api/skills lists bundled + user with origin tags and referencedBy", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/skills`);
    const body = (await res.json()) as {
      name: string;
      origin: string;
      referencedBy: string[];
      disabled: boolean;
    }[];
    expect(res.status).toBe(200);
    const byName = new Map(body.map((b) => [b.name, b]));
    expect(byName.get("coder")?.origin).toBe("both");
    expect(byName.get("reviewer")?.origin).toBe("bundled");
    expect(byName.get("custom")?.origin).toBe("user");
    // coder is referenced by the default "coding" phase
    expect(byName.get("coder")?.referencedBy).toContain("coding");
  });

  it("GET /api/skills/coder returns user override content (user takes precedence)", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/skills/coder`);
    const body = (await res.json()) as { content: string };
    expect(body.content).toBe("# user coder override\n");
  });

  it("PUT /api/skills/:name writes only under .redqueen/skills (never src/skills)", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/skills/new-thing`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# new\n" }),
    });
    expect(res.status).toBe(200);
    const written = readFileSync(
      join(tempDir, ".redqueen", "skills", "new-thing", "SKILL.md"),
      "utf8",
    );
    expect(written).toBe("# new\n");
    // bundled dir must not have been touched
    expect(existsSync(join(tempDir, "bundled-skills", "new-thing"))).toBe(false);
  });

  it("PUT /api/skills/:name rejects invalid names (uppercase, traversal, percent-encoded)", async () => {
    // Uppercase fails SKILL_NAME_RE at the routing layer.
    const uppercaseRes = await fetch(`http://127.0.0.1:${String(port)}/api/skills/BadName`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(uppercaseRes.status).toBe(404);

    // Single `..` — no slashes, but fails SKILL_NAME_RE (starts with `.`).
    const traversalRes = await fetch(`http://127.0.0.1:${String(port)}/api/skills/..`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(traversalRes.status).toBe(404);

    // `../../secret` — contains `/`, rejected by skillMatchesRoute before
    // reaching the handler. fetch normalizes this, but raw paths fail too.
    const dotDotSlashRes = await fetch(
      `http://127.0.0.1:${String(port)}/api/skills/..%2F..%2Fsecret`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      },
    );
    expect(dotDotSlashRes.status).toBe(404);

    // Absolute path — `/api/skills//etc/passwd` has an empty segment that
    // fails SKILL_NAME_RE.
    const absoluteRes = await fetch(`http://127.0.0.1:${String(port)}/api/skills/%2Fetc%2Fpasswd`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(absoluteRes.status).toBe(404);
  });

  it("DELETE /api/skills/reviewer (bundled only) returns 409 with guidance", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/skills/reviewer`, {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("skills.disabled");
  });

  it("DELETE /api/skills/custom removes user override", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/skills/custom`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(tempDir, ".redqueen", "skills", "custom"))).toBe(false);
  });
});
