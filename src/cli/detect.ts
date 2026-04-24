import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type LanguageKey =
  | "node-ts"
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "java"
  | "dotnet"
  | "blank";

export interface LanguageDetection {
  key: LanguageKey;
  displayName: string;
  markerFile: string;
}

interface Marker {
  key: LanguageKey;
  displayName: string;
  files: string[];
}

const MARKERS: Marker[] = [
  { key: "node-ts", displayName: "Node.js", files: ["package.json"] },
  { key: "dotnet", displayName: ".NET", files: [] }, // handled via suffix scan below
  {
    key: "python",
    displayName: "Python",
    files: ["pyproject.toml", "setup.py", "requirements.txt"],
  },
  { key: "go", displayName: "Go", files: ["go.mod"] },
  { key: "rust", displayName: "Rust", files: ["Cargo.toml"] },
  { key: "ruby", displayName: "Ruby", files: ["Gemfile"] },
  {
    key: "java",
    displayName: "Java",
    files: ["pom.xml", "build.gradle", "build.gradle.kts"],
  },
];

export function detectLanguages(projectDir: string): LanguageDetection[] {
  const results: LanguageDetection[] = [];

  for (const marker of MARKERS) {
    for (const file of marker.files) {
      const candidate = join(projectDir, file);
      if (existsSync(candidate)) {
        results.push({ key: marker.key, displayName: marker.displayName, markerFile: file });
        break;
      }
    }
  }

  // .NET: look for *.sln or *.csproj at depth 1.
  const dotnetMarker = findByExtension(projectDir, [".sln", ".csproj"]);
  if (dotnetMarker !== null) {
    // Insert .NET before Python if detected, to respect prototype ordering.
    const idx = results.findIndex((r) => r.key === "python");
    const entry: LanguageDetection = {
      key: "dotnet",
      displayName: ".NET",
      markerFile: dotnetMarker,
    };
    if (idx === -1) {
      results.push(entry);
    } else {
      results.splice(idx, 0, entry);
    }
  }

  return results;
}

export interface SuggestedCommands {
  build: string;
  test: string;
}

export function suggestCommands(primary: LanguageKey, projectDir: string): SuggestedCommands {
  switch (primary) {
    case "node-ts":
      return suggestNode(projectDir);
    case "dotnet":
      return { build: "dotnet build", test: "dotnet test" };
    case "python":
      return { build: "", test: "pytest" };
    case "go":
      return { build: "go build ./...", test: "go test ./..." };
    case "rust":
      return { build: "cargo build", test: "cargo test" };
    case "ruby":
      return { build: "bundle install", test: "bundle exec rspec" };
    case "java":
      return suggestJava(projectDir);
    case "blank":
      return { build: "", test: "" };
  }
}

function suggestNode(projectDir: string): SuggestedCommands {
  const pkgPath = join(projectDir, "package.json");
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- CLAUDE.md: avoid ! operator
  if (existsSync(pkgPath) === false) {
    return { build: "npm run build", test: "npm test" };
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const build = scripts.build !== undefined ? "npm run build" : "";
    const test = scripts.test !== undefined ? "npm test" : "";
    return {
      build: build !== "" ? build : "npm run build",
      test: test !== "" ? test : "npm test",
    };
  } catch {
    return { build: "npm run build", test: "npm test" };
  }
}

function suggestJava(projectDir: string): SuggestedCommands {
  if (existsSync(join(projectDir, "build.gradle"))) {
    return { build: "./gradlew build -x test", test: "./gradlew test" };
  }
  if (existsSync(join(projectDir, "build.gradle.kts"))) {
    return { build: "./gradlew build -x test", test: "./gradlew test" };
  }
  return { build: "mvn package -DskipTests", test: "mvn test" };
}

function findByExtension(projectDir: string, extensions: string[]): string | null {
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    for (const ext of extensions) {
      if (entry.endsWith(ext)) {
        return entry;
      }
    }
  }
  return null;
}

export function parseGitRemote(remoteUrl: string): { owner: string; repo: string } | null {
  // https://github.com/owner/repo.git or git@github.com:owner/repo.git
  const trimmed = remoteUrl.trim();
  const patterns = [
    /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^ssh:\/\/git@[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  ];
  for (const p of patterns) {
    const match = p.exec(trimmed);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { owner: match[1], repo: match[2] };
    }
  }
  return null;
}
