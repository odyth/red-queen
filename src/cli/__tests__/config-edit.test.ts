import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { parseConfig } from "../../core/config.js";
import {
  appendRepo,
  liftLegacyToRepos,
  readYamlDocument,
  writeYamlDocument,
} from "../config-edit.js";

const fileFaults = vi.hoisted(() => ({
  uuid: undefined as string | undefined,
  failRename: false,
  failChown: false,
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => fileFaults.uuid ?? actual.randomUUID() };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fchownSync(...args: Parameters<typeof actual.fchownSync>) {
      if (fileFaults.failChown) {
        throw new Error("ownership change failed");
      }
      actual.fchownSync(...args);
    },
    renameSync(...args: Parameters<typeof actual.renameSync>) {
      if (fileFaults.failRename) {
        throw new Error("rename failed");
      }
      actual.renameSync(...args);
    },
  };
});

const legacyYaml = [
  "# keep this comment",
  "issueTracker:",
  "  type: mock",
  "  config:",
  "    phaseFieldId: customfield_12345 # discovered field",
  "sourceControl:",
  "  type: github",
  "  config:",
  "    # repository owner",
  "    owner: acme # owner comment",
  "    repo: My_App # repo comment",
  '    auth: { type: pat, token: "${RQ_TEST_AUTH}" } # auth comment',
  "project:",
  "  directory: .",
  "  # tuned build",
  "  buildCommand: npm run build # build comment",
  "  testCommand: npm test # test comment",
  "  # project modules",
  "  modules:",
  "    # web module",
  "    - name: web",
  '      paths: ["web/**"]',
  "      buildCommand: b # module build",
  "pipeline:",
  "  baseBranch: origin/develop # base branch comment",
  "  cost:",
  "    enabled: true",
  "    pricing:",
  "      custom: { input: 2, output: 7, cacheRead: 1, cacheCreation: 3 } # tuned pricing",
  "phases:",
  "  - name: review",
  "    label: Review",
  "    type: human-gate",
  "    next: review",
  "    assignTo: human",
  "    maxIterations: 7 # tuned gate",
  "",
].join("\n");

const newRepo = {
  name: "web",
  path: "./Web",
  owner: "acme",
  repo: "Web",
  baseBranch: "origin/main",
  buildCommand: "npm run build",
  testCommand: "npm test",
  modules: [],
};

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rq-config-edit-"));
  fileFaults.uuid = undefined;
  fileFaults.failRename = false;
  fileFaults.failChown = false;
  vi.stubEnv("RQ_TEST_AUTH", "test-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe("liftLegacyToRepos", () => {
  it("moves commented fields while preserving auth, key order, and tuned configuration", () => {
    const doc = parseDocument(legacyYaml);
    const before = parseConfig(legacyYaml);
    const entry = liftLegacyToRepos(doc, "./My_App");
    const out = doc.toString();
    const after = parseConfig(out);

    expect(entry).toEqual({ ...before.project.repos[0], path: "./My_App" });
    expect(after.project.workspaceMode).toBe(true);
    expect(after.project.repos).toEqual([entry]);
    expect(after.sourceControl.config).toEqual({ auth: before.sourceControl.config.auth });
    expect(after.issueTracker).toEqual(before.issueTracker);
    expect(after.pipeline).toEqual(before.pipeline);
    expect(after.phases).toEqual(before.phases);
    for (const comment of legacyYaml.match(/#[^\n]*/g) ?? []) {
      expect(out).toContain(comment);
    }
    expect(out).toContain("${RQ_TEST_AUTH}");
    expect([...out.matchAll(/^([A-Za-z]+):/gm)].map((match) => match[1])).toEqual([
      "issueTracker",
      "sourceControl",
      "project",
      "pipeline",
      "phases",
    ]);
    expect(doc.hasIn(["sourceControl", "config", "owner"])).toBe(false);
    expect(doc.hasIn(["sourceControl", "config", "repo"])).toBe(false);
    expect(doc.hasIn(["project", "buildCommand"])).toBe(false);
    expect(doc.hasIn(["project", "testCommand"])).toBe(false);
    expect(doc.hasIn(["project", "modules"])).toBe(false);
    expect(doc.hasIn(["project", "repos", 0, "baseBranch"])).toBe(false);
  });

  it("derives identity from resolved repo variables while retaining all YAML placeholders", () => {
    vi.stubEnv("RQ_TEST_REPO", "Email_Templates");
    vi.stubEnv("RQ_TEST_OWNER", "acme");
    vi.stubEnv("RQ_TEST_AUTH", undefined);
    const doc = parseDocument(
      legacyYaml
        .replace("My_App", "${RQ_TEST_REPO}")
        .replace("owner: acme", "owner: ${RQ_TEST_OWNER}"),
    );

    const entry = liftLegacyToRepos(doc, "./Email_Templates");
    expect(entry.name).toBe("email-templates");
    expect(entry.repo).toBe("Email_Templates");
    expect(entry.owner).toBe("acme");
    expect(doc.toString()).toContain("repo: ${RQ_TEST_REPO} # repo comment");
    expect(doc.toString()).toContain("owner: ${RQ_TEST_OWNER} # owner comment");
    expect(doc.toString()).toContain("${RQ_TEST_AUTH}");
  });

  it("fails before changing the document if repository identity cannot be resolved", () => {
    vi.stubEnv("RQ_TEST_REPO", undefined);
    const doc = parseDocument(legacyYaml.replace("My_App", "${RQ_TEST_REPO}"));
    const before = doc.toString();
    expect(() => liftLegacyToRepos(doc, "./repo")).toThrow(/RQ_TEST_REPO/);
    expect(doc.toString()).toBe(before);
  });

  it.each(["Api", "${RQ_TEST_REPO}"])(
    "resolves alias-valued identity and lifted scalars while preserving placeholders: %s",
    (repoValue) => {
      vi.stubEnv("RQ_TEST_REPO", "Api");
      vi.stubEnv("RQ_TEST_OWNER", "acme");
      const yaml = [
        `sharedRepo: &sharedRepo ${repoValue} # shared repo`,
        "sharedOwner: &sharedOwner ${RQ_TEST_OWNER} # shared owner",
        "sharedBuild: &sharedBuild npm run build # shared build",
        "sharedTest: &sharedTest npm test # shared test",
        "sharedBase: &sharedBase origin/develop # shared base",
        legacyYaml
          .replace("owner: acme", "owner: *sharedOwner")
          .replace("repo: My_App", "repo: *sharedRepo")
          .replace("buildCommand: npm run build", "buildCommand: *sharedBuild")
          .replace("testCommand: npm test", "testCommand: *sharedTest")
          .replace("baseBranch: origin/develop", "baseBranch: *sharedBase"),
      ].join("\n");
      const before = parseConfig(yaml);
      const doc = parseDocument(yaml);
      const entry = liftLegacyToRepos(doc, "./Api");
      const out = doc.toString();
      const after = parseConfig(out);

      expect(entry).toEqual({ ...before.project.repos[0], path: "./Api" });
      expect(entry.name).toBe("api");
      expect(after.project.repos).toEqual([entry]);
      expect(after.issueTracker).toEqual(before.issueTracker);
      expect(after.pipeline).toEqual(before.pipeline);
      expect(out).toContain("${RQ_TEST_AUTH}");
      expect(out).toContain("${RQ_TEST_OWNER}");
      if (repoValue.startsWith("${")) {
        expect(out).toContain("${RQ_TEST_REPO}");
      }
      for (const comment of yaml.match(/#[^\n]*/g) ?? []) {
        expect(out).toContain(comment);
      }
    },
  );

  it("preserves a tracker alias of the source-control mapping when lifting its owner and repo", () => {
    const yaml = [
      "sourceControl:",
      "  type: github",
      "  config: &shared # shared adapter settings",
      "    owner: acme # shared owner",
      "    repo: Api # shared repo",
      '    auth: { type: pat, token: "${RQ_TEST_AUTH}" } # shared auth',
      "issueTracker:",
      "  type: github-issues",
      "  config: *shared # tracker alias",
      "project:",
      "  buildCommand: npm run build",
      "  testCommand: npm test",
      "",
    ].join("\n");
    const before = parseConfig(yaml);
    const doc = parseDocument(yaml);
    const entry = liftLegacyToRepos(doc, "./Api");
    const out = doc.toString();
    const after = parseConfig(out);

    expect(entry).toEqual({ ...before.project.repos[0], path: "./Api" });
    expect(after.project.repos).toEqual([entry]);
    expect(after.issueTracker).toEqual(before.issueTracker);
    expect(after.sourceControl.config).toEqual({ auth: before.sourceControl.config.auth });
    expect(out.match(/\$\{RQ_TEST_AUTH\}/g)).toHaveLength(2);
    for (const comment of yaml.match(/#[^\n]*/g) ?? []) {
      expect(out).toContain(comment);
    }
  });

  it("detaches aliased source-control and project mappings without changing the shared originals", () => {
    const yaml = [
      "sharedConfig: &sharedConfig",
      "  owner: acme # shared owner",
      "  repo: Api # shared repo",
      '  auth: { type: pat, token: "${RQ_TEST_AUTH}" } # shared auth',
      "sharedProject: &sharedProject",
      "  buildCommand: npm run build # shared build",
      "  testCommand: npm test # shared test",
      "  modules:",
      "    - name: web # shared module",
      '      paths: ["web/**"]',
      "      buildCommand: b",
      "sourceControl:",
      "  type: github",
      "  config: *sharedConfig # source-control alias",
      "issueTracker:",
      "  type: github-issues",
      "  config: *sharedConfig # tracker alias",
      "project: *sharedProject # project alias",
      "",
    ].join("\n");
    const before = parseConfig(yaml);
    const original = parseDocument(yaml).toJS() as Record<string, unknown>;
    const doc = parseDocument(yaml);
    const entry = liftLegacyToRepos(doc, "./Api");
    const out = doc.toString();
    const after = parseConfig(out);
    const rewritten = parseDocument(out).toJS() as Record<string, unknown>;

    expect(entry).toEqual({ ...before.project.repos[0], path: "./Api" });
    expect(after.project.repos).toEqual([entry]);
    expect(after.issueTracker).toEqual(before.issueTracker);
    expect(after.sourceControl.config).toEqual({ auth: before.sourceControl.config.auth });
    expect(rewritten.sharedConfig).toEqual(original.sharedConfig);
    expect(rewritten.sharedProject).toEqual(original.sharedProject);
    expect(out).toContain("${RQ_TEST_AUTH}");
    for (const comment of yaml.match(/#[^\n]*/g) ?? []) {
      expect(out).toContain(comment);
    }
  });

  it("preserves outside aliases of moved owner, repo, modules, and modified project nodes", () => {
    const yaml = [
      "sourceControl:",
      "  type: github",
      "  config:",
      "    owner: &owner acme # owner anchor",
      "    repo: &repo Api # repo anchor",
      '    auth: { type: pat, token: "${RQ_TEST_AUTH}" }',
      "project: &sharedProject # project anchor",
      "  buildCommand: npm run build",
      "  testCommand: npm test",
      "  modules: &modules # module list anchor",
      "    - name: web # module comment",
      '      paths: ["web/**"]',
      "      buildCommand: b",
      "issueTracker:",
      "  type: github-issues",
      "  config:",
      "    owner: *owner # owner alias",
      "    repo: *repo # repo alias",
      "    modules: *modules # module list alias",
      "    project: *sharedProject # project alias",
      "",
    ].join("\n");
    const before = parseConfig(yaml);
    const doc = parseDocument(yaml);
    const entry = liftLegacyToRepos(doc, "./Api");
    const out = doc.toString();
    const after = parseConfig(out);

    expect(entry).toEqual({ ...before.project.repos[0], path: "./Api" });
    expect(after.project.repos).toEqual([entry]);
    expect(after.issueTracker).toEqual(before.issueTracker);
    expect(out).toContain("${RQ_TEST_AUTH}");
    for (const comment of yaml.match(/#[^\n]*/g) ?? []) {
      expect(out).toContain(comment);
    }
  });

  it("preserves the original aliased document when environment resolution fails", () => {
    vi.stubEnv("RQ_TEST_REPO", undefined);
    const doc = parseDocument(
      "sharedRepo: &sharedRepo ${RQ_TEST_REPO}\n" +
        legacyYaml.replace("repo: My_App", "repo: *sharedRepo"),
    );
    const before = doc.toString();
    expect(() => liftLegacyToRepos(doc, "./Api")).toThrow(/RQ_TEST_REPO/);
    expect(doc.toString()).toBe(before);
  });

  it("rejects workspace input without changing it", () => {
    const doc = parseDocument(legacyYaml);
    liftLegacyToRepos(doc, "./My_App");
    const before = doc.toString();
    expect(() => liftLegacyToRepos(doc, "./My_App")).toThrow(/already in workspace mode/);
    expect(doc.toString()).toBe(before);
  });

  it("retains the existing default identity for mock source-control adapters", () => {
    const doc = parseDocument(legacyYaml.replace("type: github", "type: mock"));
    const entry = liftLegacyToRepos(doc, "./My_App");
    expect(entry.name).toBe("default");
    expect(parseConfig(doc.toString()).project.repos[0]?.name).toBe("default");
  });

  it("removes an empty source-control config while retaining comments attached to it", () => {
    const doc = parseDocument(
      legacyYaml
        .replace('    auth: { type: pat, token: "${RQ_TEST_AUTH}" } # auth comment\n', "")
        .replace(
          "  config:\n    # repository owner",
          "  config: # source settings\n    # repository owner",
        ),
    );
    liftLegacyToRepos(doc, "./My_App");
    expect(doc.hasIn(["sourceControl", "config"])).toBe(false);
    expect(doc.toString()).toContain("# source settings");
    expect(parseConfig(doc.toString()).project.repos[0]?.name).toBe("my-app");
  });
});

describe("appendRepo", () => {
  it("appends while retaining inherited base branches and rejecting duplicate names and paths", () => {
    const doc = parseDocument(legacyYaml);
    liftLegacyToRepos(doc, "./My_App");
    appendRepo(doc, newRepo);
    expect(parseConfig(doc.toString()).project.repos.map((repo) => repo.name)).toEqual([
      "my-app",
      "web",
    ]);
    expect(doc.getIn(["project", "repos", 1, "baseBranch"])).toBe("origin/main");
    const before = doc.toString();
    expect(() => {
      appendRepo(doc, { ...newRepo, path: "./different" });
    }).toThrow(/already declares repo "web"/);
    expect(() => {
      appendRepo(doc, { ...newRepo, name: "other" });
    }).toThrow(/already declares path/);
    expect(() => {
      appendRepo(doc, { ...newRepo, name: "other", path: "Web/./" });
    }).toThrow(/already declares path/);
    expect(doc.toString()).toBe(before);
  });

  it("omits matching base branches and empty modules", () => {
    const doc = parseDocument(legacyYaml);
    liftLegacyToRepos(doc, "./My_App");
    appendRepo(doc, { ...newRepo, baseBranch: "origin/develop" });
    expect(doc.hasIn(["project", "repos", 1, "baseBranch"])).toBe(false);
    expect(doc.hasIn(["project", "repos", 1, "modules"])).toBe(false);
  });

  it("compares the resolved pipeline base branch without requiring auth variables", () => {
    vi.stubEnv("RQ_TEST_BASE", "origin/main");
    vi.stubEnv("RQ_TEST_AUTH", undefined);
    const doc = parseDocument(legacyYaml.replace("origin/develop", "${RQ_TEST_BASE}"));
    liftLegacyToRepos(doc, "./My_App");
    appendRepo(doc, newRepo);
    expect(doc.hasIn(["project", "repos", 1, "baseBranch"])).toBe(false);
    expect(doc.toString()).toContain("${RQ_TEST_BASE}");
  });

  it("rejects documents without a repository sequence", () => {
    expect(() => {
      appendRepo(parseDocument(legacyYaml), newRepo);
    }).toThrow(/no project.repos/);
    expect(() => {
      appendRepo(parseDocument("project: { repos: nope }"), newRepo);
    }).toThrow(/no project.repos/);
  });
});

describe("YAML document files", () => {
  it("preserves restrictive file permissions and ignores predictable temporary symlinks", () => {
    const path = join(tmp, "redqueen.yaml");
    const unrelated = join(tmp, "unrelated");
    writeFileSync(path, legacyYaml);
    chmodSync(path, 0o640);
    const original = statSync(path);
    writeFileSync(unrelated, "keep me");
    symlinkSync(unrelated, `${path}.tmp`);
    const doc = readYamlDocument(path);
    liftLegacyToRepos(doc, "./My_App");
    writeYamlDocument(path, doc);

    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(statSync(path)).toMatchObject({ uid: original.uid, gid: original.gid });
    expect(parseConfig(readFileSync(path, "utf8")).project.workspaceMode).toBe(true);
    expect(readFileSync(unrelated, "utf8")).toBe("keep me");
    expect(readdirSync(tmp).sort()).toEqual(["redqueen.yaml", "redqueen.yaml.tmp", "unrelated"]);
  });

  it("creates new config files with private permissions", () => {
    const path = join(tmp, "new.yaml");
    writeYamlDocument(path, parseDocument(legacyYaml));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("retains an alternate supplementary group on a group-readable config", ({ skip }) => {
    const path = join(tmp, "redqueen.yaml");
    writeFileSync(path, legacyYaml, { mode: 0o640 });
    const original = statSync(path);
    const alternateGroup = process.getgroups().find((group) => group !== original.gid);
    if (alternateGroup === undefined) {
      skip();
      return;
    }
    chownSync(path, original.uid, alternateGroup);
    const doc = readYamlDocument(path);
    liftLegacyToRepos(doc, "./My_App");
    writeYamlDocument(path, doc);

    expect(statSync(path)).toMatchObject({ uid: original.uid, gid: alternateGroup });
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(parseConfig(readFileSync(path, "utf8")).project.workspaceMode).toBe(true);
  });

  it("leaves the original config intact if its ownership cannot be retained", () => {
    const path = join(tmp, "redqueen.yaml");
    writeFileSync(path, legacyYaml, { mode: 0o640 });
    const original = statSync(path);
    const doc = readYamlDocument(path);
    liftLegacyToRepos(doc, "./My_App");
    fileFaults.failChown = true;
    expect(() => {
      writeYamlDocument(path, doc);
    }).toThrow(/ownership change failed/);

    expect(statSync(path)).toMatchObject({
      uid: original.uid,
      gid: original.gid,
      mode: original.mode,
    });
    expect(readFileSync(path, "utf8")).toBe(legacyYaml);
    expect(readdirSync(tmp)).toEqual(["redqueen.yaml"]);
  });

  it("opens the random temporary path exclusively and never follows or removes a colliding symlink", () => {
    const path = join(tmp, "redqueen.yaml");
    const unrelated = join(tmp, "unrelated");
    writeFileSync(path, legacyYaml);
    writeFileSync(unrelated, "keep me");
    fileFaults.uuid = "collision";
    const tempPath = join(tmp, ".redqueen.yaml.collision.tmp");
    symlinkSync(unrelated, tempPath);
    expect(() => {
      writeYamlDocument(path, parseDocument(legacyYaml));
    }).toThrow(/EEXIST/);
    expect(readFileSync(path, "utf8")).toBe(legacyYaml);
    expect(readFileSync(unrelated, "utf8")).toBe("keep me");
    expect(existsSync(tempPath)).toBe(true);
  });

  it("retains the old config and cleans its temporary file when replacement fails", () => {
    const path = join(tmp, "redqueen.yaml");
    writeFileSync(path, legacyYaml);
    const doc = readYamlDocument(path);
    liftLegacyToRepos(doc, "./My_App");
    fileFaults.failRename = true;
    expect(() => {
      writeYamlDocument(path, doc);
    }).toThrow(/rename failed/);
    expect(readFileSync(path, "utf8")).toBe(legacyYaml);
    expect(readdirSync(tmp)).toEqual(["redqueen.yaml"]);
  });

  it("refuses malformed YAML and invalid root shapes", () => {
    const path = join(tmp, "bad.yaml");
    writeFileSync(path, "project: [broken\n");
    expect(() => readYamlDocument(path)).toThrow(/Invalid YAML/);
    writeFileSync(path, "- not\n- a config\n");
    expect(() => readYamlDocument(path)).toThrow(/mapping/);
  });

  it("keeps existing files and leaves no temporary artifacts when serialization fails", () => {
    const path = join(tmp, "redqueen.yaml");
    writeFileSync(path, legacyYaml);
    expect(() => {
      writeYamlDocument(path, parseDocument("project: [broken\n"));
    }).toThrow();
    expect(readFileSync(path, "utf8")).toBe(legacyYaml);
    expect(readdirSync(tmp)).toEqual(["redqueen.yaml"]);
  });

  it("refuses non-regular destinations without modifying their contents", () => {
    const path = join(tmp, "directory");
    mkdirSync(path);
    const target = join(tmp, "target");
    writeFileSync(target, "original");
    const link = join(tmp, "link");
    symlinkSync(target, link);
    expect(() => {
      writeYamlDocument(path, parseDocument(legacyYaml));
    }).toThrow(/regular file/);
    expect(() => {
      writeYamlDocument(link, parseDocument(legacyYaml));
    }).toThrow(/regular file/);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("original");
    expect(readdirSync(tmp).sort()).toEqual(["directory", "link", "target"]);
  });
});
