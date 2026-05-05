import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfigFromProject } from "./config-discovery.js";
import { CliError } from "./errors.js";
import { isProcessAlive, readPidFile, removePidFile, resolvePidPath } from "./pid.js";

export async function cmdStop(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help === true) {
    process.stdout.write("redqueen stop — send SIGTERM to a running redqueen instance\n");
    return;
  }

  const { config, projectRoot } = loadConfigFromProject(process.cwd());
  const projectDir = resolve(projectRoot, config.project.directory);
  const pidPath = resolvePidPath(projectDir);

  const pid = readPidFile(pidPath);
  if (pid === null) {
    process.stdout.write("No running redqueen instance found.\n");
    return;
  }
  if (isProcessAlive(pid) === false) {
    removePidFile(pidPath);
    process.stdout.write(`Stale PID file — process ${String(pid)} is gone. Cleaned up.\n`);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    throw new CliError(
      `Failed to send SIGTERM to pid ${String(pid)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  process.stdout.write(`Sent SIGTERM to pid ${String(pid)}. Waiting for shutdown...\n`);

  const gracefulTimeoutMs = (config.pipeline.workerTimeout + 30) * 1000;
  const deadline = Date.now() + gracefulTimeoutMs;
  while (Date.now() < deadline) {
    if (isProcessAlive(pid) === false) {
      removePidFile(pidPath);
      process.stdout.write(`redqueen stopped (pid ${String(pid)}).\n`);
      return;
    }
    await sleep(1000);
  }

  process.stderr.write(
    `Process ${String(pid)} did not exit within ${String(gracefulTimeoutMs / 1000)}s — sending SIGKILL.\n`,
  );
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already dead
  }
  await sleep(5000);
  if (isProcessAlive(pid)) {
    throw new CliError(`Pid ${String(pid)} still alive after SIGKILL`);
  }
  removePidFile(pidPath);
  process.stdout.write(`redqueen force-stopped (pid ${String(pid)}).\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}
