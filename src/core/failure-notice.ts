import type { WorkerResult } from "./worker.js";
import { sanitizeWorkerDiagnostic } from "./worker-diagnostics.js";

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
  destinationLabel: string | null;
  transitionPending?: boolean;
  assignmentIncomplete?: boolean;
  issueId?: string;
  attempts: number;
  result: WorkerResult;
}

// Builds the markdown comment posted to a ticket when a worker failure parks it
// at a human gate. Both trackers render markdown (GitHub natively, Jira via
// toAdf), so the heading and code fence survive the round trip.
export function buildFailureNotice(input: FailureNoticeInput): string {
  const details = failureDetails(input.result);
  const disposition =
    input.destinationLabel === null
      ? "Automatic work is paused in the current phase because no human failure route is configured."
      : input.transitionPending === true
        ? `Automatic work is paused while Red Queen retries the handoff to **${input.destinationLabel}**. The tracker phase or assignment update has not completed.`
        : input.assignmentIncomplete === true
          ? `This ticket reached **${input.destinationLabel}**, but the human assignment could not be completed. See the assignment failure notice for recovery instructions.`
          : `This ticket has been moved to **${input.destinationLabel}** for a human to take a look.`;
  const recovery =
    input.destinationLabel === null && input.issueId !== undefined
      ? `After fixing the problem, run \`redqueen pipeline resume ${input.issueId}\` from the project directory, or move the ticket through a human gate and back. Without webhooks, leave it at the gate for a reconciliation sweep.`
      : "Resolve the failure, then move the ticket from its human gate to an automated phase to retry. Pending tracker writes are retried during reconciliation.";

  if (looksLikeAuthFailure(details)) {
    return [
      "## 🔴 Red Queen couldn't authenticate with Claude",
      "",
      `The **${input.phaseLabel}** worker failed with what looks like an authentication error. Red Queen runs its AI workers with credentials on its host, so until those are fixed **every ticket will fail the same way** — this is not a problem with this ticket.`,
      "",
      "Check the Claude credentials where Red Queen runs (API key / `claude` login / Bedrock access).",
      "",
      disposition,
      "",
      recovery,
      "",
      "Worker output:",
      codeBlock(details),
    ].join("\n");
  }

  const attemptsNote = input.attempts > 1 ? ` after ${String(input.attempts)} attempts` : "";
  return [
    `## ⚠️ ${input.phaseLabel} didn't complete`,
    "",
    `Red Queen's **${input.phaseLabel}** worker failed${attemptsNote}. ${disposition}`,
    "",
    recovery,
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
  // error arrives sanitized from the worker/orchestrator; summary is raw parsed
  // stdout and this comment is its only path out of the system.
  const summary = sanitizeWorkerDiagnostic(result.summary);
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
