import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Resolve the absolute path to the `claude` binary on the current PATH by
 * invoking `which claude`. Argv-based — never shelled — so path contents
 * can't be interpolated into a shell string.
 *
 * Returns the trimmed first line of stdout, or null when `which` exits
 * non-zero (binary not on PATH). launchd's user-agent PATH is minimal, so
 * `redqueen service install` captures this explicitly rather than relying
 * on the service's runtime PATH to resolve it.
 */
export async function detectClaudeBin(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", ["claude"]);
    const first = stdout.split(/\r?\n/)[0] ?? "";
    const trimmed = first.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}
