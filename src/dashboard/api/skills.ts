import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { RuntimeState } from "../../core/runtime-state.js";

export interface SkillsApiDeps {
  runtime: RuntimeState;
  projectRoot: string;
  builtInSkillsDir: string;
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_BODY_BYTES = 1 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", rejectPromise);
  });
}

function userSkillsDir(deps: SkillsApiDeps): string {
  return resolve(deps.projectRoot, ".redqueen", "skills");
}

// Cross-client interop locations defined by the agentskills.io implementation
// guide. The project-level path travels with the repo; the user-level path is
// shared across all projects on the machine.
function agentsSkillsDirs(deps: SkillsApiDeps): string[] {
  const dirs = [resolve(deps.projectRoot, ".agents", "skills")];
  const home = homedir();
  if (home !== "") {
    dirs.push(join(home, ".agents", "skills"));
  }
  return dirs;
}

function listSkillNames(dir: string): string[] {
  if (existsSync(dir) === false) {
    return [];
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() === false) {
      continue;
    }
    const skillFile = join(dir, entry.name, "SKILL.md");
    if (existsSync(skillFile) === false) {
      continue;
    }
    out.push(entry.name);
  }
  return out.sort();
}

interface SkillEntry {
  name: string;
  origin: "bundled" | "user" | "both";
  disabled: boolean;
  referencedBy: string[];
}

function buildSkillList(deps: SkillsApiDeps): SkillEntry[] {
  const bundled = new Set(listSkillNames(deps.builtInSkillsDir));
  const userNames = new Set(listSkillNames(userSkillsDir(deps)));
  const agentsNames = new Set<string>();
  for (const dir of agentsSkillsDirs(deps)) {
    for (const name of listSkillNames(dir)) {
      agentsNames.add(name);
    }
  }
  // .agents/skills/ entries are treated as user-side for origin labeling — the
  // dashboard's edit/delete operations target the configured user dir, so any
  // change to an agents-skills entry creates an override there.
  const nonBundled = new Set([...userNames, ...agentsNames]);
  const disabled = new Set(deps.runtime.config.skills.disabled);
  const all = new Set([...bundled, ...nonBundled]);
  const phases = deps.runtime.config.phases;
  const entries: SkillEntry[] = [];
  for (const name of [...all].sort()) {
    const inBundled = bundled.has(name);
    const inNonBundled = nonBundled.has(name);
    const origin: SkillEntry["origin"] =
      inBundled && inNonBundled ? "both" : inNonBundled ? "user" : "bundled";
    const referencedBy = phases.filter((p) => p.skill === name).map((p) => p.name);
    entries.push({
      name,
      origin,
      disabled: disabled.has(name),
      referencedBy,
    });
  }
  return entries;
}

function resolveSkillName(name: string | null): string | null {
  if (name === null || name.length === 0) {
    return null;
  }
  if (SKILL_NAME_RE.test(name) === false) {
    return null;
  }
  return name;
}

export function handleSkillsList(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: SkillsApiDeps,
): void {
  sendJson(res, 200, buildSkillList(deps));
}

function extractSkillNameFromPath(pathname: string): string | null {
  const prefix = "/api/skills/";
  if (pathname.startsWith(prefix) === false) {
    return null;
  }
  const raw = pathname.slice(prefix.length);
  if (raw.length === 0) {
    return null;
  }
  return resolveSkillName(raw);
}

function readSkillContent(deps: SkillsApiDeps, name: string): string | null {
  const searchDirs = [userSkillsDir(deps), ...agentsSkillsDirs(deps), deps.builtInSkillsDir];
  for (const dir of searchDirs) {
    const candidate = join(dir, name, "SKILL.md");
    if (existsSync(candidate)) {
      return readFileSync(candidate, "utf8");
    }
  }
  return null;
}

export function handleSkillGet(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SkillsApiDeps,
): void {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const name = extractSkillNameFromPath(pathname);
  if (name === null) {
    sendJson(res, 400, { error: "invalid skill name" });
    return;
  }
  const content = readSkillContent(deps, name);
  if (content === null) {
    sendJson(res, 404, { error: "skill not found" });
    return;
  }
  sendJson(res, 200, { name, content });
}

export async function handleSkillPut(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SkillsApiDeps,
): Promise<void> {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const name = extractSkillNameFromPath(pathname);
  if (name === null) {
    sendJson(res, 400, { error: "invalid skill name" });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendText(res, 413, "Payload Too Large");
    return;
  }

  let content = body;
  if (req.headers["content-type"]?.includes("application/json") === true) {
    try {
      const parsed = JSON.parse(body) as { content?: unknown };
      if (typeof parsed.content !== "string") {
        sendJson(res, 400, { error: "content field required" });
        return;
      }
      content = parsed.content;
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
  }

  const targetDir = join(userSkillsDir(deps), name);
  const resolved = resolve(targetDir);
  const userRoot = resolve(userSkillsDir(deps));
  if (resolved.startsWith(`${userRoot}${sep}`) === false && resolved !== userRoot) {
    sendJson(res, 400, { error: "path escapes user skills directory" });
    return;
  }

  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "SKILL.md"), content, { encoding: "utf8" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: `write failed: ${message}` });
    return;
  }

  sendJson(res, 200, { ok: true, name });
}

export function handleSkillDelete(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SkillsApiDeps,
): void {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const name = extractSkillNameFromPath(pathname);
  if (name === null) {
    sendJson(res, 400, { error: "invalid skill name" });
    return;
  }

  const userPath = join(userSkillsDir(deps), name);
  const hasUserOverride = existsSync(join(userPath, "SKILL.md"));
  const hasBundled = existsSync(join(deps.builtInSkillsDir, name, "SKILL.md"));
  const hasAgents = agentsSkillsDirs(deps).some((dir) => existsSync(join(dir, name, "SKILL.md")));

  if (hasUserOverride === false) {
    if (hasBundled) {
      sendJson(res, 409, {
        message: "Built-in skill cannot be deleted. Add its name to skills.disabled to disable.",
      });
      return;
    }
    if (hasAgents) {
      sendJson(res, 409, {
        message:
          "Skill is provided by .agents/skills/. Remove it from that location directly, or add its name to skills.disabled to disable.",
      });
      return;
    }
    sendJson(res, 404, { error: "skill not found" });
    return;
  }

  try {
    rmSync(userPath, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: `delete failed: ${message}` });
    return;
  }
  sendJson(res, 200, { ok: true, name });
}

export function skillMatchesRoute(pathname: string): boolean {
  // Only `/api/skills/<valid-name>` — reject traversal, slashes, uppercase, etc.
  const prefix = "/api/skills/";
  if (pathname.startsWith(prefix) === false) {
    return false;
  }
  const rest = pathname.slice(prefix.length);
  if (rest.length === 0 || rest.includes("/")) {
    return false;
  }
  return SKILL_NAME_RE.test(rest);
}

export function userSkillsDirForTests(deps: SkillsApiDeps): string {
  return userSkillsDir(deps);
}

export function statSkillFile(path: string): { exists: boolean; mode?: number } {
  if (existsSync(path) === false) {
    return { exists: false };
  }
  return { exists: true, mode: statSync(path).mode };
}
