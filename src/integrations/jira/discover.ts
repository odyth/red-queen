import type { JiraClient } from "./client.js";
import { levenshtein } from "../../core/strings.js";

interface JiraFieldSchema {
  type?: string;
  custom?: string;
}

interface JiraField {
  id: string;
  name: string;
  custom?: boolean;
  schema?: JiraFieldSchema;
}

interface JiraFieldContext {
  id: string;
  name?: string;
  isGlobalContext?: boolean;
}

interface JiraFieldContextsResponse {
  values: JiraFieldContext[];
}

interface JiraCustomFieldOption {
  id: string;
  value: string;
  disabled?: boolean;
}

interface JiraCustomFieldOptionsResponse {
  values: JiraCustomFieldOption[];
}

export interface FieldCandidate {
  id: string;
  name: string;
  customType: string | null;
  type: string | null;
}

export interface PhaseOptionMatch {
  phaseName: string;
  matched: { optionId: string; optionValue: string; reason: "label" | "name" | "fuzzy" } | null;
}

export interface DiscoveryResult {
  phaseFieldCandidates: FieldCandidate[];
  specFieldCandidates: FieldCandidate[];
  /** Options pulled from the default context of the selected phase field. */
  phaseOptions: { fieldId: string; options: { id: string; value: string }[] };
  phaseMatches: PhaseOptionMatch[];
}

export interface DiscoverInput {
  client: JiraClient;
  phases: { name: string; label?: string }[];
  /** Optional override when the user's phase field is named something other than "phase". */
  phaseFieldNameHint?: string;
}

/**
 * Discover Jira custom field metadata and propose a phase mapping. Pure
 * orchestration — does no I/O beyond the JiraClient. Returns all candidates
 * so the CLI layer can prompt for disambiguation; unmatched phases are
 * reported explicitly rather than guessed.
 */
export async function discoverJiraSchema(input: DiscoverInput): Promise<DiscoveryResult> {
  const { client, phases } = input;

  const allFields = await client.request<JiraField[]>("GET", "/rest/api/3/field");

  const phaseFieldCandidates = findPhaseFieldCandidates(allFields, input.phaseFieldNameHint);
  const specFieldCandidates = findSpecFieldCandidates(allFields);

  let phaseOptions: { fieldId: string; options: { id: string; value: string }[] } = {
    fieldId: "",
    options: [],
  };
  if (phaseFieldCandidates.length > 0) {
    const primary = phaseFieldCandidates[0]?.id ?? "";
    phaseOptions = {
      fieldId: primary,
      options: await fetchPhaseOptions(client, primary),
    };
  }

  const phaseMatches = matchPhases(phases, phaseOptions.options);
  return { phaseFieldCandidates, specFieldCandidates, phaseOptions, phaseMatches };
}

function findPhaseFieldCandidates(
  fields: readonly JiraField[],
  hint: string | undefined,
): FieldCandidate[] {
  const needle = (hint ?? "phase").toLowerCase();
  const matches: FieldCandidate[] = [];
  for (const field of fields) {
    const isSelect =
      field.schema?.custom === "com.atlassian.jira.plugin.system.customfieldtypes:select";
    const nameMatches = field.name.toLowerCase().includes(needle);
    if (isSelect && nameMatches) {
      matches.push(toCandidate(field));
    }
  }
  return matches;
}

function findSpecFieldCandidates(fields: readonly JiraField[]): FieldCandidate[] {
  const matches: FieldCandidate[] = [];
  for (const field of fields) {
    const name = field.name.toLowerCase();
    if (name.includes("spec") === false && name.includes("specification") === false) {
      continue;
    }
    const isTextarea =
      field.schema?.custom === "com.atlassian.jira.plugin.system.customfieldtypes:textarea";
    const isString = field.schema?.type === "string";
    if (isTextarea || isString) {
      matches.push(toCandidate(field));
    }
  }
  return matches;
}

function toCandidate(field: JiraField): FieldCandidate {
  return {
    id: field.id,
    name: field.name,
    customType: field.schema?.custom ?? null,
    type: field.schema?.type ?? null,
  };
}

export async function fetchPhaseOptions(
  client: JiraClient,
  fieldId: string,
): Promise<{ id: string; value: string }[]> {
  const contexts = await client.request<JiraFieldContextsResponse>(
    "GET",
    `/rest/api/3/field/${encodeURIComponent(fieldId)}/context`,
  );
  // Jira doesn't guarantee ordering; a project-scoped context would expose a
  // different option set than the default. Prefer the global context so the
  // proposed mapping matches what most tickets will actually see.
  const primary = contexts.values.find((c) => c.isGlobalContext === true) ?? contexts.values[0];
  if (primary === undefined) {
    return [];
  }
  const optionsResponse = await client.request<JiraCustomFieldOptionsResponse>(
    "GET",
    `/rest/api/3/field/${encodeURIComponent(fieldId)}/context/${encodeURIComponent(primary.id)}/option`,
  );
  return optionsResponse.values
    .filter((option) => option.disabled !== true)
    .map((option) => ({ id: option.id, value: option.value }));
}

export function matchPhases(
  phases: readonly { name: string; label?: string }[],
  options: readonly { id: string; value: string }[],
): PhaseOptionMatch[] {
  const normalizedOptions = options.map((option) => ({
    ...option,
    normalized: option.value.toLowerCase().trim(),
  }));

  return phases.map((phase) => {
    const targets = [phase.label, phase.name]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .map((value) => value.toLowerCase().trim());

    // Exact-label, then exact-name, then fuzzy (Levenshtein ≤ 3).
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i] ?? "";
      const hit = normalizedOptions.find((option) => option.normalized === target);
      if (hit !== undefined) {
        return {
          phaseName: phase.name,
          matched: {
            optionId: hit.id,
            optionValue: hit.value,
            reason: i === 0 && phase.label !== undefined ? "label" : "name",
          },
        };
      }
    }

    let best: { option: { id: string; value: string }; distance: number } | null = null;
    for (const target of targets) {
      for (const option of normalizedOptions) {
        const distance = levenshtein(target, option.normalized);
        if (distance <= 3 && (best === null || distance < best.distance)) {
          best = { option, distance };
        }
      }
    }
    if (best !== null) {
      return {
        phaseName: phase.name,
        matched: {
          optionId: best.option.id,
          optionValue: best.option.value,
          reason: "fuzzy",
        },
      };
    }

    return { phaseName: phase.name, matched: null };
  });
}
