import { stripVTControlCharacters } from "node:util";

const REDACTED = "<redacted>";

const SENSITIVE_KEY =
  "(?:x-(?:amz|goog)-(?:credential|signature)|awsaccesskeyid|googleaccessid|" +
  "api[ _-]?key|(?:access[ _-]?)?token|refresh[ _-]?token|" +
  "(?:client[ _-]?)?secret|password|credential|sig(?:nature)?)";
const AUTH_CREDENTIAL_RE = /(\b(?:Bearer|Basic))[^\S\n]+(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu;
const URL_USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/giu;
const SENSITIVE_KEY_VALUE_RE = new RegExp(
  `(["']?\\w*${SENSITIVE_KEY}\\w*["']?\\s*(?:=|:)\\s*)` + `(?:"[^"\\n]*"|'[^'\\n]*'|[^&\\s,;]+)`,
  "giu",
);
const LONG_TOKEN_RE = /[A-Za-z0-9+/=_-]{20,}/gu;
const WARNING_PREFIX_RE = /^(?:warning|warn)\b(?:\s*[:-])?/iu;
const EFFORT_PROBLEM_RE = /\b(?:unsupported|unknown|invalid)\b/iu;
const EFFORT_RE = /effort\b/iu;
const FALLBACK_RE = /\b(?:default(?:ed|ing)?|fallback|falling back|using)\b/iu;

/**
 * Makes untrusted worker diagnostics safe for durable logs and external output.
 * The caller remains responsible for applying any context-specific length cap.
 */
export function sanitizeWorkerDiagnostic(input: string): string {
  const withoutVt = stripVTControlCharacters(input);
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
      .replace(SENSITIVE_KEY_VALUE_RE, `$1${REDACTED}`)
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
