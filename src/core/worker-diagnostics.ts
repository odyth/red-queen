import { stripVTControlCharacters } from "node:util";

const REDACTED = "<redacted>";

const SENSITIVE_KEY =
  "(?:x-(?:amz|goog)-(?:credential|signature)|awsaccesskeyid|googleaccessid|" +
  "api[ _-]?key|(?:access[ _-]?)?token|refresh[ _-]?token|" +
  "(?:client[ _-]?)?secret|password|credential|sig(?:nature)?)";
const AUTH_CREDENTIAL_RE = /(\b(?:Bearer|Basic))[^\S\n]+(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu;
const URL_USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/giu;
// The \w quantifiers around the key must stay bounded: unbounded \w* backtracks
// quadratically on long word-character runs (base64 blobs, minified JS), which
// is a ReDoS against the orchestrator's event loop.
const SENSITIVE_KEY_VALUE_RE = new RegExp(
  `(["']?\\w{0,64}${SENSITIVE_KEY}\\w{0,64}["']?\\s*(?:=|:)\\s*)` +
    `(?:"[^"\\n]*"|'[^'\\n]*'|[^&\\s,;]+)`,
  "giu",
);
// Counter fields (input_tokens, max_tokens, …) share the "token" substring with
// credential keys; a plural key holding a small integer is a count, not a secret.
const COUNT_KEY_PREFIX_RE = /tokens["']?\s*[=:]\s*$/iu;
const COUNT_VALUE_RE = /^["']?\d{1,16}["']?$/u;
const LONG_TOKEN_RE = /[A-Za-z0-9+/=_-]{20,}/gu;
// Worker stderr arrives up to 10MB; bounding the input here keeps every regex
// pass cheap regardless of caller discipline. All callers cap output far lower.
const MAX_SANITIZE_INPUT_LENGTH = 16_384;
const SANITIZE_TRUNCATION_MARKER = "...[diagnostic truncated]";
const WARNING_PREFIX_RE = /^(?:warning|warn)\b(?:\s*[:-])?/iu;
const EFFORT_PROBLEM_RE = /\b(?:unsupported|unknown|invalid)\b/iu;
const EFFORT_RE = /effort\b/iu;
const FALLBACK_RE = /\b(?:default(?:ed|ing)?|fallback|falling back|using)\b/iu;

/**
 * Makes untrusted worker diagnostics safe for durable logs and external output.
 * Input is capped internally; the caller remains responsible for applying any
 * context-specific length cap on the result.
 */
export function sanitizeWorkerDiagnostic(input: string): string {
  const capped =
    input.length <= MAX_SANITIZE_INPUT_LENGTH
      ? input
      : `${input.substring(0, MAX_SANITIZE_INPUT_LENGTH)}${SANITIZE_TRUNCATION_MARKER}`;
  const withoutVt = stripVTControlCharacters(capped);
  const normalizedControls = normalizeControlCharacters(withoutVt);
  const normalizedWhitespace = normalizedControls
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

  return (
    normalizedWhitespace
      .replace(AUTH_CREDENTIAL_RE, `$1 ${REDACTED}`)
      .replace(URL_USERINFO_RE, `$1${REDACTED}@`)
      .replace(SENSITIVE_KEY_VALUE_RE, (match, prefix: string) => {
        const value = match.slice(prefix.length);
        return COUNT_KEY_PREFIX_RE.test(prefix) && COUNT_VALUE_RE.test(value)
          ? match
          : `${prefix}${REDACTED}`;
      })
      // Digit-free runs are identifiers or paths (authentication_error,
      // /Users/…), not credentials — real tokens virtually always carry digits.
      .replace(LONG_TOKEN_RE, (match) => (/\d/u.test(match) ? REDACTED : match))
  );
}

/**
 * Retains actionable warnings from a successful worker without persisting all
 * stderr; undefined when nothing is recognized. Recognition runs before
 * redaction so a redacted token (e.g. the model_reasoning_effort config key)
 * can't hide the fallback line it appears in.
 */
export function extractSuccessfulWorkerWarning(stderr: string): string | undefined {
  const warningLines = normalizeControlCharacters(stripVTControlCharacters(stderr))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isRecognizedWarning(line))
    .map((line) => sanitizeWorkerDiagnostic(line));

  return warningLines.length > 0 ? warningLines.join("\n") : undefined;
}

function normalizeControlCharacters(input: string): string {
  const normalizedNewlines = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let result = "";

  for (const character of normalizedNewlines) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint === 0x0a) {
      result += "\n";
      continue;
    }
    if (codePoint === 0x09 || codePoint === 0x0b || codePoint === 0x0c) {
      result += " ";
      continue;
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      continue;
    }
    result += character;
  }

  return result;
}

function isRecognizedWarning(line: string): boolean {
  if (WARNING_PREFIX_RE.test(line)) {
    return true;
  }
  return EFFORT_PROBLEM_RE.test(line) && EFFORT_RE.test(line) && FALLBACK_RE.test(line);
}
