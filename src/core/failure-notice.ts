import type { WorkerResult } from "./worker.js";

// Substrings that mark a worker failure as an authentication/credentials problem
// rather than a normal task failure. Kept tight on purpose: worker output can
// quote arbitrary source, so every entry here is a phrase that realistically
// only appears when the Claude CLI itself can't authenticate.
const AUTH_SIGNALS = [
  "401",
  "403",
  "authentication_error",
  "authentication failed",
  "failed to authenticate",
  "invalid api key",
  "invalid x-api-key",
  "unauthorized",
  "oauth token",
  "please run /login",
  "/login",
];

export function looksLikeAuthFailure(text: string): boolean {
  const lowered = text.toLowerCase();
  return AUTH_SIGNALS.some((signal) => lowered.includes(signal));
}

const DETAIL_MAX = 3000;

export interface FailureNoticeInput {
  phaseLabel: string;
  destinationLabel: string;
  attempts: number;
  result: WorkerResult;
}

// Builds the markdown comment posted to a ticket when a worker failure parks it
// at a human gate. Both trackers render markdown (GitHub natively, Jira via
// toAdf), so the heading and code fence survive the round trip.
export function buildFailureNotice(input: FailureNoticeInput): string {
  const details = failureDetails(input.result);

  if (looksLikeAuthFailure(details)) {
    return [
      "## 🔴 Red Queen couldn't authenticate with Claude",
      "",
      `The **${input.phaseLabel}** worker failed with what looks like an authentication error. Red Queen runs its AI workers with credentials on its host, so until those are fixed **every ticket will fail the same way** — this is not a problem with this ticket.`,
      "",
      "Check the Claude credentials where Red Queen runs (API key / `claude` login / Bedrock access).",
      "",
      `This ticket has been parked in **${input.destinationLabel}** in the meantime.`,
      "",
      "Worker output:",
      codeBlock(details),
    ].join("\n");
  }

  const attemptsNote = input.attempts > 1 ? ` after ${String(input.attempts)} attempts` : "";
  return [
    `## ⚠️ ${input.phaseLabel} didn't complete`,
    "",
    `Red Queen's **${input.phaseLabel}** worker failed${attemptsNote}, so this ticket has been moved to **${input.destinationLabel}** for a human to take a look.`,
    "",
    "Worker output:",
    codeBlock(details),
  ].join("\n");
}

// Collapses a WorkerResult into the most informative text we can show. error
// holds the worker's stderr / kill reason; summary holds the parsed stdout
// result. On an auth failure one or the other carries the "401" string, so we
// surface both unless they duplicate each other.
function failureDetails(result: WorkerResult): string {
  const error = (result.error ?? "").trim();
  const summary = result.summary.trim();
  const hasSummary = summary.length > 0 && summary !== "Completed (no output)";
  const bareExitCode = /^exit code -?\d+$/i.test(error);

  const parts: string[] = [];
  // A bare "Exit code N" is the worker's last resort when nothing hit stderr —
  // drop it when the parsed summary carries the real reason instead.
  if (error.length > 0 && (bareExitCode === false || hasSummary === false)) {
    parts.push(error);
  }
  if (hasSummary && error.includes(summary) === false) {
    parts.push(summary);
  }
  if (parts.length === 0) {
    parts.push(`Exit code ${String(result.exitCode)}`);
  }
  return truncate(parts.join("\n\n"), DETAIL_MAX);
}

function codeBlock(text: string): string {
  // Neutralize any fence inside the worker output so it can't close ours early.
  return ["```", text.replace(/```/g, "'''"), "```"].join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n...[truncated]`;
}
