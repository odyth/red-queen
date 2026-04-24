export const PHASE_LABEL_PREFIX = "rq:phase:";
export const ACTIVE_LABEL = "rq:active";

export function phaseLabel(phaseName: string): string {
  return `${PHASE_LABEL_PREFIX}${phaseName}`;
}

export function isPhaseLabel(name: string): boolean {
  return name.startsWith(PHASE_LABEL_PREFIX);
}

export function phaseFromLabel(name: string): string | null {
  if (isPhaseLabel(name) === false) {
    return null;
  }
  return name.slice(PHASE_LABEL_PREFIX.length);
}

/**
 * Hard-coded muted palette. Config knob intentionally omitted — the hex
 * values aren't important enough to expose as user config.
 */
const LABEL_COLORS: Record<string, string> = {
  "rq:active": "6a737d",
  "rq:phase:spec-writing": "fbca04",
  "rq:phase:spec-review": "d4c5f9",
  "rq:phase:coding": "1d76db",
  "rq:phase:code-review": "0e8a16",
  "rq:phase:testing": "5319e7",
  "rq:phase:human-review": "e99695",
  "rq:phase:spec-feedback": "fbca04",
  "rq:phase:code-feedback": "fbca04",
  "rq:phase:blocked": "d73a4a",
};

const DEFAULT_COLOR = "ededed";

export function colorFor(labelName: string): string {
  return LABEL_COLORS[labelName] ?? DEFAULT_COLOR;
}
