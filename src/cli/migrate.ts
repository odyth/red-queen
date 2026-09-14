import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { isScalar, parseDocument, stringify } from "yaml";
import type { Document } from "yaml";
import { interpolateEnv, parseConfig } from "../core/config.js";
import type { RedQueenConfig } from "../core/config.js";
import { RedQueenDatabase } from "../core/database.js";
import { loadDotEnv } from "../core/env.js";
import { PipelineStateStore } from "../core/pipeline-state.js";
import {
  contextFromConfig,
  createServiceManager,
  shellSingleQuote,
  UnsupportedPlatformError,
  writeWrapperScript,
} from "../core/service/index.js";
import type { ServiceInstallContext, ServiceManager } from "../core/service/index.js";
import { generateWorkspaceMap, mergeRegeneratedMap } from "./codebase-map.js";
import { liftLegacyToRepos, readYamlDocument, writeYamlDocument } from "./config-edit.js";
import { detectLanguages } from "./detect.js";
import { CliError } from "./errors.js";
import { printHelp } from "./help.js";
import { isProcessAlive, readPidFile, resolvePidPath } from "./pid.js";
import { isGitWorkTreeRoot, listRegisteredWorktrees } from "./repo-discovery.js";
import { resolveRedqueenBinPath } from "./service.js";

interface IPathMove {
  from: string;
  to: string;
}

export interface MigrationPlan {
  installDir: string;
  parentDir: string;
  dirName: string;
  repoName: string;
  worktreeMoves: IPathMove[];
  staleRefreshWorktrees: string[];
  fileMoves: IPathMove[];
  preservedWorktreeEntries: string[];
  serviceInstalled: boolean;
  serviceEnabled: boolean;
  oldService: ServiceInstallContext;
  newService: ServiceInstallContext;
  configYaml: string;
  map: string;
  fingerprint: string;
}

export interface IMigrationIO {
  git?: (args: string[], cwd: string) => string;
  moveFile?: (from: string, to: string) => void;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function present(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function requireFile(path: string): void {
  if (lstatSync(path).isFile() === false) {
    throw new CliError(`${path} must be a regular file for migration`);
  }
}

function requireAbsent(path: string): void {
  if (present(path)) {
    throw new CliError(`${path} already exists — refusing to overwrite`);
  }
}

function checkStopped(installDir: string): void {
  const pid = readPidFile(resolvePidPath(installDir));
  if (pid !== null && isProcessAlive(pid)) {
    throw new CliError(
      `The orchestrator is running (pid ${String(pid)}). Stop it with redqueen stop / redqueen service stop before migrating.`,
    );
  }
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function canonicalInstallPath(path: string, installDir: string): string {
  // Resolve alternate spellings of the install root (/var vs /private/var on
  // macOS, or a symlink used in an absolute config path). Keep symlinks below
  // the root intact; their target topology is checked separately.
  let ancestor = path;
  while (dirname(ancestor) !== ancestor) {
    if (existsSync(ancestor) && realpathSync(ancestor) === installDir) {
      return resolve(installDir, relative(ancestor, path));
    }
    ancestor = dirname(ancestor);
  }
  return path;
}

function movedPath(path: string, installDir: string, moves: IPathMove[]): string {
  path = canonicalInstallPath(path, installDir);
  for (const move of moves) {
    if (under(path, move.from)) {
      return resolve(move.to, relative(move.from, path));
    }
  }
  const stateRoot = join(installDir, ".redqueen");
  // Unknown worktree-root data stays in place. Other state paths follow the
  // new root, including configured logs/skills that have not been created yet.
  if (under(path, stateRoot) && under(path, join(stateRoot, "worktrees")) === false) {
    return resolve(dirname(installDir), ".redqueen", relative(stateRoot, path));
  }
  return path;
}

function validateMovedSymlinks(installDir: string, files: IPathMove[], moves: IPathMove[]): void {
  const inspect = (from: string, to: string): void => {
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(from);
      const originalTarget = resolve(dirname(from), link);
      const expectedTarget = movedPath(originalTarget, installDir, moves);
      const actualTarget = resolve(dirname(to), link);
      if (canonicalInstallPath(actualTarget, installDir) !== expectedTarget) {
        throw new CliError(
          `Cannot migrate symlink ${from}: moving it to ${to} would resolve to ${actualTarget}, instead of ${expectedTarget}. Use a relative link entirely within .redqueen, or an absolute link to data that stays outside it, then rerun redqueen migrate. No files have moved.`,
        );
      }
    } else if (stat.isDirectory()) {
      for (const entry of readdirSync(from)) {
        inspect(join(from, entry), join(to, entry));
      }
    }
  };
  for (const move of files) {
    inspect(move.from, move.to);
  }
}

function validateReferencedSymlinks(
  path: string,
  field: string,
  installDir: string,
  moves: IPathMove[],
  depth = 0,
): void {
  if (depth >= 40) {
    throw new CliError(
      `Cannot migrate ${field}: too many symlink components in ${path}. Resolve the link chain before migrating.`,
    );
  }
  let current = parsePath(path).root;
  const parts = path.slice(current.length).split(sep);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) {
      return;
    }
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(current);
      const originalTarget = resolve(dirname(current), link);
      // Inspect only the configured path's components, including links that
      // stay in the repository. Such a link can still break when its target
      // is moved out of .redqueen underneath it.
      const move = moves.find((entry) => under(current, entry.from));
      const destination =
        move === undefined ? current : resolve(move.to, relative(move.from, current));
      const actualTarget = resolve(dirname(destination), link);
      const expectedTarget = movedPath(originalTarget, installDir, moves);
      if (canonicalInstallPath(actualTarget, installDir) !== expectedTarget) {
        throw new CliError(
          `Cannot migrate ${field}: its symlink component ${current} would resolve to ${actualTarget}, instead of ${expectedTarget}. Point the configured path directly at its .redqueen target, or repair the link so its target remains valid after migration, then rerun redqueen migrate. No files have moved.`,
        );
      }
      validateReferencedSymlinks(
        join(originalTarget, ...parts.slice(index + 1)),
        field,
        installDir,
        moves,
        depth + 1,
      );
      return;
    }
  }
}

function setString(doc: Document, key: string[], value: string): void {
  const node = doc.getIn(key, true);
  if (isScalar(node)) {
    node.value = value;
  } else {
    doc.setIn(key, value);
  }
}

function rewritePath(
  doc: Document,
  key: string[],
  oldBase: string,
  newBase: string,
  installDir: string,
  moves: IPathMove[],
): void {
  const value: unknown = doc.getIn(key);
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    throw new CliError(`${key.join(".")} must be a string path`);
  }
  const expanded = interpolateEnv(value);
  const oldPath = resolve(oldBase, expanded);
  validateReferencedSymlinks(oldPath, key.join("."), installDir, moves);
  const target = movedPath(oldPath, installDir, moves);
  if (canonicalInstallPath(resolve(newBase, expanded), installDir) === target) {
    return;
  }
  let replacement: string;
  if (/\$\{[A-Z_][A-Z0-9_]*\}/.test(value)) {
    const prefixed = `${relative(newBase, oldBase) || "."}/${value}`;
    if (
      isAbsolute(expanded) ||
      canonicalInstallPath(resolve(newBase, interpolateEnv(prefixed)), installDir) !== target
    ) {
      throw new CliError(
        `Cannot preserve ${key.join(".")} while moving its environment-based path. Set this field to a relative literal path (for example .redqueen/keys/app.pem), then rerun redqueen migrate. Its environment placeholder has not been changed.`,
      );
    }
    replacement = prefixed;
  } else {
    replacement = isAbsolute(expanded) ? target : relative(newBase, target) || ".";
  }
  setString(doc, key, replacement);
}

// Validate all orchestration settings without resolving unrelated adapter
// secrets. The YAML Document itself is retained verbatim except for path/lift
// edits; these projected values are never written back to disk.
function configForMigration(doc: Document): RedQueenConfig {
  const raw = doc.toJS() as Record<string, unknown>;
  const validation = Object.fromEntries(
    Object.entries(raw).filter(([key]) =>
      [
        "issueTracker",
        "sourceControl",
        "project",
        "pipeline",
        "phases",
        "skills",
        "dashboard",
        "audit",
        "service",
      ].includes(key),
    ),
  );
  for (const key of ["sourceControl", "issueTracker"]) {
    const adapter = validation[key] as { config?: Record<string, unknown> } | undefined;
    if (adapter?.config === undefined) {
      continue;
    }
    const auth = adapter.config.auth as { type?: unknown } | undefined;
    adapter.config = {
      ...(adapter.config.owner === undefined ? {} : { owner: adapter.config.owner }),
      ...(adapter.config.repo === undefined ? {} : { repo: adapter.config.repo }),
      ...(auth?.type === undefined ? {} : { auth: { type: auth.type } }),
      ...(adapter.config.webhookSecret === undefined ? {} : { webhookSecret: "migration-secret" }),
    };
  }
  return parseConfig(stringify(validation));
}

function plannedWorktrees(
  installDir: string,
  repoName: string,
): {
  worktreeMoves: IPathMove[];
  staleRefreshWorktrees: string[];
  preservedWorktreeEntries: string[];
} {
  const root = join(installDir, ".redqueen", "worktrees");
  const worktreeMoves: IPathMove[] = [];
  const staleRefreshWorktrees: string[] = [];
  for (const { path, locked } of listRegisteredWorktrees(installDir)) {
    if (under(path, root) === false) {
      continue;
    }
    if (dirname(path) !== root || locked) {
      throw new CliError(
        `Cannot migrate nested or locked worktree ${path}; resolve its layout/lock first.`,
      );
    }
    if (existsSync(path) === false || isGitWorkTreeRoot(path) === false) {
      throw new CliError(
        `Registered worktree ${path} is missing or invalid; repair its Git registration first.`,
      );
    }
    if (
      git(["ls-files", "--stage"], path)
        .split("\n")
        .some((line) => line.startsWith("160000 "))
    ) {
      throw new CliError(
        `Worktree ${path} contains submodules, which git worktree move cannot move. Resolve it before migrating.`,
      );
    }
    if (basename(path).startsWith("refresh-")) {
      staleRefreshWorktrees.push(path);
    } else {
      worktreeMoves.push({
        from: path,
        to: join(dirname(installDir), ".redqueen", "worktrees", basename(path), repoName),
      });
    }
  }
  const known = new Set([...worktreeMoves.map((move) => move.from), ...staleRefreshWorktrees]);
  const preservedWorktreeEntries = present(root)
    ? readdirSync(root)
        .sort()
        .map((entry) => join(root, entry))
        .filter((path) => known.has(path) === false)
    : [];
  return { worktreeMoves, staleRefreshWorktrees, preservedWorktreeEntries };
}

function checkDatabase(path: string, repoName: string): void {
  if (present(path) === false) {
    return;
  }
  requireFile(path);
  // SQLite opens in WAL mode can create -wal/-shm even with readonly:true.
  // Check a private disposable copy, including crash-recovery WAL contents,
  // so dry-run never initializes/upgrades or writes into the real install.
  const temporary = mkdtempSync(join(tmpdir(), "redqueen-migration-check-"));
  try {
    const copied = join(temporary, "redqueen.db");
    copyFileSync(path, copied);
    if (present(`${path}-wal`)) {
      requireFile(`${path}-wal`);
      copyFileSync(`${path}-wal`, `${copied}-wal`);
    }
    const database = new RedQueenDatabase(copied);
    try {
      if (database.db.pragma("quick_check", { simple: true }) !== "ok") {
        throw new CliError(`Database integrity check failed for ${path}`);
      }
      new PipelineStateStore(database.db, [repoName]).adoptLegacyRows(repoName, true);
    } finally {
      database.close();
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function planMigration(cwd: string): MigrationPlan {
  const installDir = realpathSync(cwd);
  const parentDir = dirname(installDir);
  const configPath = join(installDir, "redqueen.yaml");
  if (present(configPath) === false) {
    throw new CliError("redqueen migrate needs redqueen.yaml in the current install directory");
  }
  requireFile(configPath);
  if (isGitWorkTreeRoot(installDir) === false) {
    throw new CliError(`${installDir} is not a git work tree root`);
  }
  if (parentDir === installDir) {
    throw new CliError("The install directory has no parent");
  }
  for (const entry of ["redqueen.yaml", ".redqueen", ".env"]) {
    requireAbsent(join(parentDir, entry));
  }
  for (const path of [join(installDir, ".redqueen"), join(installDir, ".redqueen", "worktrees")]) {
    if (present(path) && lstatSync(path).isDirectory() === false) {
      throw new CliError(`${path} must be a directory, not a symlink or file`);
    }
  }
  const version = /git version (\d+)\.(\d+)/.exec(git(["--version"], installDir));
  const major = Number(version?.[1] ?? 0);
  if (major < 2 || (major === 2 && Number(version?.[2] ?? 0) < 17)) {
    throw new CliError("git >= 2.17 is required for git worktree move");
  }
  checkStopped(installDir);
  const envPath = join(installDir, ".env");
  if (present(envPath)) {
    requireFile(envPath);
  }
  // Planning must not leave .env values in the caller, or a later revalidation
  // could accidentally reuse old values after the user edits the file.
  const loaded = loadDotEnv(installDir, 0).loaded;
  try {
    const doc = readYamlDocument(configPath);
    const before = configForMigration(doc);
    if (before.project.workspaceMode) {
      throw new CliError("redqueen.yaml is already in workspace mode — nothing to migrate");
    }
    const projectDir = resolve(installDir, before.project.directory);
    if (existsSync(projectDir) === false || realpathSync(projectDir) !== installDir) {
      throw new CliError(
        "project.directory must resolve to the install directory; align it with redqueen.yaml before migrating",
      );
    }
    const dirName = basename(installDir);
    const entry = liftLegacyToRepos(doc, `./${dirName}`);
    const worktrees = plannedWorktrees(installDir, entry.name);
    const stateRoot = join(installDir, ".redqueen");
    const fileMoves = present(stateRoot)
      ? readdirSync(stateRoot)
          .sort()
          .filter((name) => name !== "worktrees")
          .map((name) => ({ from: join(stateRoot, name), to: join(parentDir, ".redqueen", name) }))
      : [];
    fileMoves.push({ from: configPath, to: join(parentDir, "redqueen.yaml") });
    if (present(envPath)) {
      fileMoves.push({ from: envPath, to: join(parentDir, ".env") });
    }
    const moves = [...worktrees.worktreeMoves, ...fileMoves];
    validateMovedSymlinks(installDir, fileMoves, moves);
    // Defaults are references too: a moved skills/log link may traverse a
    // stationary link outside .redqueen even when no YAML override is present.
    for (const [field, path, base] of [
      ["skills.directory", before.skills.directory, installDir],
      ["audit.logFile", before.audit.logFile, stateRoot],
      ["service.envFile", before.service.envFile, installDir],
      ["service.stdoutLog", before.service.stdoutLog, installDir],
      ["service.stderrLog", before.service.stderrLog, installDir],
    ] as const) {
      if (doc.hasIn(field.split(".")) === false) {
        validateReferencedSymlinks(resolve(base, path), field, installDir, moves);
      }
    }
    for (const key of [
      ["sourceControl", "config", "auth", "privateKeyPath"],
      ["issueTracker", "config", "auth", "privateKeyPath"],
      ["skills", "directory"],
      ["service", "envFile"],
      ["service", "stdoutLog"],
      ["service", "stderrLog"],
    ]) {
      rewritePath(doc, key, installDir, parentDir, installDir, moves);
    }
    for (const binary of ["claudeBin", "codexBin"]) {
      const value: unknown = doc.getIn(["pipeline", binary]);
      if (typeof value === "string" && interpolateEnv(value).includes("/")) {
        rewritePath(doc, ["pipeline", binary], installDir, parentDir, installDir, moves);
      }
    }
    rewritePath(
      doc,
      ["audit", "logFile"],
      stateRoot,
      join(parentDir, ".redqueen"),
      installDir,
      moves,
    );
    setString(doc, ["project", "directory"], ".");
    if (doc.hasIn(["service", "workingDirectory"])) {
      setString(doc, ["service", "workingDirectory"], ".");
    }
    const after = configForMigration(doc);
    const mapPath = join(stateRoot, "codebase-map.md");
    const languages = detectLanguages(installDir);
    const generated = generateWorkspaceMap({
      rootDir: parentDir,
      generatedAt: new Date().toISOString().slice(0, 10),
      repos: [{ ...entry, path: installDir, languages, primary: languages[0]?.key ?? "blank" }],
    });
    let map = generated;
    if (present(mapPath)) {
      requireFile(mapPath);
      map = mergeRegeneratedMap(readFileSync(mapPath, "utf8"), generated);
    }
    checkDatabase(join(stateRoot, "redqueen.db"), entry.name);
    const hash = createHash("sha256");
    for (const path of [
      configPath,
      envPath,
      mapPath,
      join(stateRoot, "redqueen.db"),
      join(stateRoot, "redqueen.db-wal"),
    ]) {
      if (present(path)) {
        hash.update(path).update(readFileSync(path));
      }
    }
    hash.update(JSON.stringify({ ...worktrees, fileMoves, config: doc.toString() }));
    const binary = resolveRedqueenBinPath();
    return {
      installDir,
      parentDir,
      dirName,
      repoName: entry.name,
      ...worktrees,
      fileMoves,
      serviceInstalled: false,
      serviceEnabled: before.service.enabled,
      oldService: contextFromConfig(before, installDir, binary),
      newService: contextFromConfig(after, parentDir, binary),
      configYaml: doc.toString(),
      map,
      fingerprint: hash.digest("hex"),
    };
  } finally {
    for (const key of loaded) {
      Reflect.deleteProperty(process.env, key);
    }
  }
}

function revalidate(plan: MigrationPlan): void {
  if (planMigration(plan.installDir).fingerprint !== plan.fingerprint) {
    throw new CliError(
      "The install changed after migration was planned. Rerun redqueen migrate to review the new plan.",
    );
  }
}

function failure(
  plan: MigrationPlan,
  step: string,
  error: unknown,
  moved: IPathMove[],
  files: IPathMove[],
  removed: string[],
): CliError {
  const lines = [
    `Migration failed during ${step}: ${error instanceof Error ? error.message : String(error)}`,
  ];
  if (moved.length > 0) {
    lines.push("Worktrees already moved. Exact reverse commands:");
    for (const move of [...moved].reverse()) {
      lines.push(`  mkdir -p ${shellSingleQuote(dirname(move.from))}`);
      lines.push(
        `  git -C ${shellSingleQuote(plan.installDir)} worktree move ${shellSingleQuote(move.to)} ${shellSingleQuote(move.from)}`,
      );
    }
  } else {
    lines.push("No worktrees were moved.");
  }
  if (files.length > 0) {
    lines.push("Files already moved (review config/database changes before reversing):");
    for (const move of [...files].reverse()) {
      lines.push(`  mkdir -p ${shellSingleQuote(dirname(move.from))}`);
      lines.push(`  mv -n ${shellSingleQuote(move.to)} ${shellSingleQuote(move.from)}`);
    }
  }
  if (removed.length > 0) {
    lines.push(
      `Stale refresh worktrees removed: ${removed.join(", ")}. They are disposable and were not backed up.`,
    );
  }
  lines.push("Do not start the orchestrator until config, database paths, and worktrees agree.");
  return new CliError(lines.join("\n"));
}

function rewriteDatabase(plan: MigrationPlan): void {
  const path = join(plan.parentDir, ".redqueen", "redqueen.db");
  if (present(path) === false) {
    return;
  }
  const database = new RedQueenDatabase(path);
  try {
    database.db.transaction(() => {
      for (const table of ["pipeline_state", "pipeline_repos"]) {
        const rows = database.db
          .prepare(`SELECT DISTINCT worktree_path FROM ${table} WHERE worktree_path IS NOT NULL`)
          .all() as { worktree_path: string }[];
        const update = database.db.prepare(
          `UPDATE ${table} SET worktree_path = ? WHERE worktree_path = ?`,
        );
        for (const row of rows) {
          // Canonicalize existing /tmp or /var aliases only for matching a
          // planned move. Literal equality in SQL avoids wildcard path bugs.
          const source = resolve(plan.installDir, row.worktree_path);
          const canonical = canonicalInstallPath(source, plan.installDir);
          const move = plan.worktreeMoves.find((item) => item.from === canonical);
          if (move !== undefined) {
            update.run(move.to, row.worktree_path);
          }
        }
      }
      new PipelineStateStore(database.db, [plan.repoName]).adoptLegacyRows(plan.repoName, true);
    })();
  } finally {
    database.close();
  }
}

export function executeMigration(plan: MigrationPlan, io: IMigrationIO = {}): void {
  revalidate(plan);
  const runGit = io.git ?? git;
  const moveFile = io.moveFile ?? renameSync;
  const moved: IPathMove[] = [];
  const files: IPathMove[] = [];
  const removed: string[] = [];
  let step = "creating the destination";
  try {
    // Exclusive root creation also catches a destination created after the
    // final preflight; never merge into another install's state directory.
    createStateDirectory(join(plan.parentDir, ".redqueen"), join(plan.installDir, ".redqueen"));
    createStateDirectory(
      join(plan.parentDir, ".redqueen", "worktrees"),
      join(plan.installDir, ".redqueen", "worktrees"),
    );
    step = "worktree moves";
    for (const move of plan.worktreeMoves) {
      mkdirSync(dirname(move.to), { recursive: true });
      runGit(["worktree", "move", "--", move.from, move.to], plan.installDir);
      moved.push(move);
    }
    for (const path of plan.staleRefreshWorktrees) {
      runGit(["worktree", "remove", "--force", "--", path], plan.installDir);
      removed.push(path);
    }
    step = "file moves";
    for (const move of plan.fileMoves) {
      requireAbsent(move.to);
      moveFile(move.from, move.to);
      files.push(move);
    }
    step = "database rewrite and legacy adoption";
    rewriteDatabase(plan);
    step = "config rewrite";
    const doc = parseDocument(plan.configYaml);
    if (plan.serviceInstalled && doc.hasIn(["service", "name"]) === false) {
      setString(doc, ["service", "name"], plan.oldService.name);
    }
    writeYamlDocument(join(plan.parentDir, "redqueen.yaml"), doc);
    step = "workspace map conversion";
    writeFileSync(join(plan.parentDir, ".redqueen", "codebase-map.md"), plan.map);
    step = "empty directory cleanup";
    for (const path of [
      join(plan.installDir, ".redqueen", "worktrees"),
      join(plan.installDir, ".redqueen"),
    ]) {
      if (present(path) && readdirSync(path).length === 0) {
        rmdirSync(path);
      }
    }
  } catch (error) {
    throw failure(plan, step, error, moved, files, removed);
  }
}

function createStateDirectory(path: string, original: string): void {
  mkdirSync(path, { mode: 0o700 });
  const source = lstatSync(original, { throwIfNoEntry: false });
  if (source !== undefined) {
    // Private source directories may protect otherwise-readable keys/logs.
    // Restore ownership first (chown can clear mode bits), before any contents
    // move. A failure leaves an empty destination and the original data intact.
    chownSync(path, source.uid, source.gid);
    chmodSync(path, source.mode & 0o7777);
  }
}

function printPlan(plan: MigrationPlan): void {
  const lines = [
    `Migrate ${plan.installDir} → ${plan.parentDir} (repo ${plan.repoName})`,
    "Worktrees to move:",
  ];
  lines.push(...plan.worktreeMoves.map((move) => `  ${move.from} → ${move.to}`));
  lines.push(
    ...plan.staleRefreshWorktrees.map((path) => `  Remove stale refresh worktree: ${path}`),
  );
  lines.push("Files to move:", ...plan.fileMoves.map((move) => `  ${move.from} → ${move.to}`));
  lines.push(
    ...plan.preservedWorktreeEntries.map((path) => `  Preserve in place (unregistered): ${path}`),
  );
  lines.push(
    "Config: convert project.repos and preserve referenced paths and comments.",
    "State: rewrite recorded worktree paths, adopt legacy rows, and preserve map notes.",
  );
  if (plan.serviceInstalled) {
    lines.push(
      plan.serviceEnabled
        ? `Service: unload and reinstall ${plan.oldService.name} last (install starts it).`
        : `Service: uninstall ${plan.oldService.name}; service.enabled is false, so it stays stopped.`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n\n`);
}

async function inspectService(plan: MigrationPlan, manager: ServiceManager): Promise<boolean> {
  const status = await manager.status(plan.oldService);
  if (status.running) {
    throw new CliError(
      `Service ${plan.oldService.name} is running. Stop it with redqueen service stop before migrating.`,
    );
  }
  if (status.installed && plan.serviceEnabled && present(plan.oldService.wrapperScriptPath)) {
    // The installer rewrites this file. Never follow an existing wrapper link
    // and overwrite a target outside the migrated state directory.
    requireFile(plan.oldService.wrapperScriptPath);
  }
  return status.installed;
}

export async function cmdMigrate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    printHelp("migrate");
    return;
  }
  const plan = planMigration(process.cwd());
  let manager: ServiceManager | null;
  try {
    manager = createServiceManager();
  } catch (error) {
    if (error instanceof UnsupportedPlatformError === false) {
      throw error;
    }
    manager = null;
  }
  if (manager !== null) {
    plan.serviceInstalled = await inspectService(plan, manager);
  }
  printPlan(plan);
  if (values["dry-run"]) {
    process.stdout.write("Dry run — nothing changed.\n");
    return;
  }
  if (values.yes === false) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question("Proceed? [y/N]: ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        process.stdout.write("Aborted.\n");
        return;
      }
    } finally {
      rl.close();
    }
  }
  revalidate(plan);
  if (manager !== null) {
    if ((await inspectService(plan, manager)) !== plan.serviceInstalled) {
      throw new CliError("Service installation changed after planning; rerun redqueen migrate.");
    }
    // The async service query can race with an interactive edit or a restart.
    revalidate(plan);
    if (plan.serviceInstalled) {
      if (plan.serviceEnabled) {
        await manager.stop(plan.oldService);
      } else {
        await manager.uninstall(plan.oldService);
      }
      const stillInstalled = await inspectService(plan, manager);
      if (plan.serviceEnabled === false && stillInstalled) {
        throw new CliError(
          `Service ${plan.oldService.name} is still installed after uninstall; resolve it before migrating.`,
        );
      }
    }
  }
  executeMigration(plan);
  if (plan.serviceInstalled && plan.serviceEnabled && manager !== null) {
    const context = { ...plan.newService, name: plan.oldService.name };
    try {
      writeWrapperScript(context.wrapperScriptPath, {
        envFilePath: context.envFilePath,
        redqueenBinPath: context.redqueenBinPath,
        nodeBinPath: process.execPath,
      });
      await manager.install(context);
    } catch (error) {
      throw failure(
        plan,
        "service reinstall",
        error,
        plan.worktreeMoves,
        plan.fileMoves,
        plan.staleRefreshWorktrees,
      );
    }
  }
  process.stdout.write(
    [
      `Migrated. The install now lives at ${plan.parentDir}.`,
      `Next: cd ${shellSingleQuote(plan.parentDir)}`,
      `  1. Review redqueen.yaml (project.repos[0] is ${plan.repoName}).`,
      "  2. redqueen init --add-repo <path>   # once per sibling repo",
      "  3. Add one source-control webhook per sibling repo (or one org-level webhook), using the same URL and secret.",
      plan.serviceInstalled && plan.serviceEnabled
        ? "  4. The reinstalled service has started; check redqueen service status."
        : "  4. redqueen start   # when ready",
      ...plan.preservedWorktreeEntries.map((path) => `Preserved unregistered data at ${path}.`),
      "",
    ].join("\n"),
  );
}
