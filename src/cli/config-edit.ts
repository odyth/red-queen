import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMap, isNode, isScalar, isSeq, parseDocument, stringify, visit } from "yaml";
import type { Alias, Document, Node, YAMLMap } from "yaml";
import { interpolateEnv, parseConfig } from "../core/config.js";
import type { RepoConfig } from "../core/config.js";
import { CliError } from "./errors.js";

function validateDocument(doc: Document): void {
  if (doc.errors.length > 0) {
    throw new CliError(`Invalid YAML: ${doc.errors.map((error) => error.message).join("; ")}`);
  }
  if (isMap(doc.contents) === false) {
    throw new CliError("redqueen.yaml must contain a YAML mapping");
  }
}

export function readYamlDocument(path: string): Document {
  const doc = parseDocument(readFileSync(path, "utf8"));
  validateDocument(doc);
  return doc;
}

export function writeYamlDocument(path: string, doc: Document): void {
  validateDocument(doc);
  const content = doc.toString();
  const original = lstatSync(path, { throwIfNoEntry: false });
  if (original?.isFile() === false) {
    throw new CliError(`Cannot rewrite ${path}: the destination must be a regular file`);
  }
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let created = false;
  try {
    // Create exclusively and privately; neither a pre-existing symlink nor
    // the process umask may expose credentials while the content is written.
    fd = openSync(tmp, "wx", 0o600);
    created = true;
    writeFileSync(fd, content, { encoding: "utf8" });
    if (original !== undefined) {
      // Ownership is part of access control too. If it cannot be retained,
      // leave the original file intact instead of granting a different group
      // access to embedded credentials. chown may clear mode bits, so do it first.
      fchownSync(fd, original.uid, original.gid);
    }
    fchmodSync(fd, original === undefined ? 0o600 : original.mode & 0o7777);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
    if (created) {
      rmSync(tmp, { force: true });
    }
  }
}

function stringAt(doc: Document, path: string[]): string | undefined {
  const node = doc.getIn(path, true);
  const value: unknown = isNode(node) ? node.toJS(doc) : node;
  return typeof value === "string" ? value : undefined;
}

function materializeAliases(doc: Document): void {
  const snapshots = new Map<Alias, Node>();
  // Resolve every alias against the original tree before any nodes move or
  // change. In particular, a tracker sharing an anchored source-control config
  // must retain its owner/repo, and moving an anchor must not leave earlier
  // references dangling. toJS resolves YAML aliases without interpolating env.
  visit(doc, {
    Alias(_key, alias) {
      const value: unknown = alias.toJS(doc);
      const snapshot = doc.createNode(value);
      snapshot.commentBefore = alias.commentBefore;
      snapshot.comment = alias.comment;
      snapshot.spaceBefore = alias.spaceBefore;
      snapshots.set(alias, snapshot);
    },
  });
  visit(doc, {
    Alias(_key, alias) {
      return snapshots.get(alias);
    },
  });
}

function movePair(source: YAMLMap, destination: YAMLMap, key: string): void {
  const pair = source.items.find((item) => isScalar(item.key) && item.key.value === key);
  if (pair !== undefined) {
    destination.add(pair);
    source.delete(key);
  }
}

// Callers load the install's .env first. Parse only the lifted fields to reuse
// legacy identity/default normalization without requiring unrelated auth vars.
// The original YAML pairs are moved below, so their placeholders and comments
// remain in the document even though the returned entry has resolved values.
export function liftLegacyToRepos(document: Document, repoPath: string): RepoConfig {
  validateDocument(document);
  // Work on a copy so invalid aliases or missing env values cannot leave the
  // caller with a partially rewritten document.
  const doc = document.clone();
  materializeAliases(doc);
  if (doc.hasIn(["project", "repos"])) {
    throw new CliError("redqueen.yaml is already in workspace mode (project.repos is set)");
  }
  const project = doc.getIn(["project"], true);
  if (isMap(project) === false) {
    throw new CliError("redqueen.yaml must contain a project mapping");
  }
  const modulesNode = doc.getIn(["project", "modules"], true);
  const modules: unknown = isNode(modulesNode) ? modulesNode.toJS(doc) : undefined;
  const config = parseConfig(
    stringify({
      issueTracker: { type: "mock" },
      sourceControl: {
        type: stringAt(doc, ["sourceControl", "type"]) ?? "github",
        config: {
          owner: stringAt(doc, ["sourceControl", "config", "owner"]) ?? "",
          repo: stringAt(doc, ["sourceControl", "config", "repo"]) ?? "",
        },
      },
      project: {
        directory: repoPath,
        buildCommand: stringAt(doc, ["project", "buildCommand"]) ?? "",
        testCommand: stringAt(doc, ["project", "testCommand"]) ?? "",
        ...(modules === undefined ? {} : { modules }),
      },
      pipeline: { baseBranch: stringAt(doc, ["pipeline", "baseBranch"]) ?? "origin/main" },
    }),
  );
  const entry = config.project.repos[0];
  if (entry === undefined) {
    throw new CliError("Cannot derive the legacy repository from redqueen.yaml");
  }
  const yamlEntry: YAMLMap = doc.createNode({ name: entry.name, path: repoPath });
  const sourceConfig = doc.getIn(["sourceControl", "config"], true);
  for (const key of ["owner", "repo"] as const) {
    if (isMap(sourceConfig) && sourceConfig.has(key)) {
      movePair(sourceConfig, yamlEntry, key);
    } else {
      yamlEntry.set(key, entry[key]);
    }
  }
  for (const key of ["buildCommand", "testCommand"] as const) {
    if (project.has(key)) {
      movePair(project, yamlEntry, key);
    } else {
      yamlEntry.set(key, entry[key]);
    }
  }
  movePair(project, yamlEntry, "modules");
  // Keep pipeline.baseBranch as the inherited default rather than adding an
  // override that would stop following future changes to the workspace base.
  doc.setIn(["project", "repos"], doc.createNode([yamlEntry]));
  if (isMap(sourceConfig) && sourceConfig.items.length === 0) {
    const sourceControl = doc.getIn(["sourceControl"], true);
    if (isMap(sourceControl)) {
      const configPair = sourceControl.items.find(
        (item) => isScalar(item.key) && item.key.value === "config",
      );
      const key = configPair?.key;
      const comments = [
        isScalar(key) ? key.commentBefore : undefined,
        isScalar(key) ? key.comment : undefined,
        sourceConfig.commentBefore,
        sourceConfig.comment,
      ].filter((comment): comment is string => typeof comment === "string");
      if (comments.length > 0) {
        sourceControl.comment = [sourceControl.comment, ...comments]
          .filter((comment): comment is string => typeof comment === "string")
          .join("\n");
      }
      sourceControl.delete("config");
    }
  }
  document.contents = doc.contents;
  return entry;
}

export function appendRepo(doc: Document, entry: RepoConfig): void {
  validateDocument(doc);
  const repos = doc.getIn(["project", "repos"], true);
  if (isSeq(repos) === false) {
    throw new CliError(
      "redqueen.yaml has no project.repos — run `redqueen migrate` or `redqueen init` first",
    );
  }
  for (const repo of repos.items) {
    if (isMap(repo) === false) {
      throw new CliError("redqueen.yaml project.repos entries must be mappings");
    }
    const name: unknown = repo.get("name");
    const path: unknown = repo.get("path");
    if (typeof name === "string" && interpolateEnv(name) === entry.name) {
      throw new CliError(`redqueen.yaml already declares repo "${entry.name}"`);
    }
    if (
      typeof path === "string" &&
      join(interpolateEnv(path), ".") === join(interpolateEnv(entry.path), ".")
    ) {
      throw new CliError(`redqueen.yaml already declares path "${entry.path}"`);
    }
  }
  const pipelineBase = interpolateEnv(stringAt(doc, ["pipeline", "baseBranch"]) ?? "origin/main");
  const yamlEntry: Record<string, unknown> = {
    name: entry.name,
    path: entry.path,
    owner: entry.owner,
    repo: entry.repo,
  };
  if (entry.baseBranch !== pipelineBase) {
    yamlEntry.baseBranch = entry.baseBranch;
  }
  yamlEntry.buildCommand = entry.buildCommand;
  yamlEntry.testCommand = entry.testCommand;
  if (entry.modules.length > 0) {
    yamlEntry.modules = entry.modules;
  }
  repos.add(doc.createNode(yamlEntry));
}
