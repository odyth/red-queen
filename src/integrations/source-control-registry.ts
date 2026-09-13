import type { SourceControl } from "./source-control.js";

export interface SourceControlRegistryEntry {
  name: string;
  fullName: string;
  adapter: SourceControl;
}

// One adapter per configured repo, all sharing one auth strategy. Adapters stay
// single-repo objects; callers that must pick a repo take the name from the
// pipeline repo row they are acting on.
export interface SourceControlRegistry {
  get(repoName: string): SourceControl;
  byFullName(fullName: string): SourceControlRegistryEntry | null;
  names(): string[];
  any(): SourceControl;
}

export function repoFullName(repo: { name: string; owner: string; repo: string }): string {
  return repo.owner !== "" && repo.repo !== "" ? `${repo.owner}/${repo.repo}` : repo.name;
}

export function createSourceControlRegistry(
  entries: readonly SourceControlRegistryEntry[],
): SourceControlRegistry {
  const first = entries[0];
  if (first === undefined) {
    throw new Error("SourceControlRegistry needs at least one repo");
  }
  const byName = new Map<string, SourceControlRegistryEntry>();
  const byFull = new Map<string, SourceControlRegistryEntry>();
  for (const entry of entries) {
    if (byName.has(entry.name)) {
      throw new Error(`Duplicate repo name "${entry.name}" in SourceControlRegistry`);
    }
    const fullName = entry.fullName.toLowerCase();
    if (byFull.has(fullName)) {
      throw new Error(`Duplicate repo full name "${entry.fullName}" in SourceControlRegistry`);
    }
    byName.set(entry.name, entry);
    byFull.set(fullName, entry);
  }
  const names = entries.map((e) => e.name);
  return {
    get(repoName) {
      const entry = byName.get(repoName);
      if (entry === undefined) {
        throw new Error(`Unknown repo "${repoName}" — valid repos: ${names.join(", ")}`);
      }
      return entry.adapter;
    },
    byFullName(fullName) {
      return byFull.get(fullName.toLowerCase()) ?? null;
    },
    names() {
      return [...names];
    },
    any() {
      return first.adapter;
    },
  };
}
