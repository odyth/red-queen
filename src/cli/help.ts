import { packageVersion } from "../core/version.js";

const HELP_TEXT = `Red Queen v${packageVersion()} — deterministic orchestrator for AI coding agents

Usage:
  redqueen <command> [options]

Top-level commands:
  init                        Scaffold a project in a git repo or a folder of git repos (workspace)
  migrate                     Move a single-repo install up into a workspace (--dry-run, --yes)
  start                       Start the orchestrator (foreground)
  stop                        Stop a running orchestrator
  status                      Show orchestrator status
  service <sub>               Manage the background daemon (install/start/stop/restart/status/uninstall)
  jira <sub>                  Jira helpers (discover)

Helper commands (called by skills):
  issue get <id>              Fetch an issue as JSON
  issue comment <id>          Post a comment (--body or stdin)
  issue comments <id>         List comments as JSON
  issue attachments <id>      Download attachments (--dir <path>)
  spec get <id>               Print the stored spec
  spec set <id>               Set the spec (--body or stdin)
  spec meta <id>              Record spec metadata (--open-questions <N> --repos a,b)
  pr create                   Create a PR (--issue --head --base --title [--repo], body via stdin)
  pr diff <number>            Print the PR diff (--repo <name> in workspace mode)
  pr checks <number>          Print CI check status (--wait <seconds>) [--repo]
  pr review <number>          Post a review (--verdict, body via stdin) [--repo]
  pr reviews <number>         List reviews as JSON (--latest for the most recent) [--repo]
  pr comments <number>        List review comments as JSON [--repo]
  pr comment <number>         Post a PR-level comment (--body or stdin) [--repo]
  pr reply <number> <id>      Reply to a review comment (--body or stdin) [--repo]
  pipeline update <issueId>   Update a repo row (--repo --branch --pr --worktree --clear-pr --clear-worktree)
  pipeline cleanup <issueId>  Remove worktrees and local branches for every repo (--keep-branch)
  stack setup <issueId>       Assemble stacked worktrees for unfinished in-scope repos
                              (--spec = detached exploration worktrees for every repo).
                              Exit 2 = merge conflict (JSON names the repo), 3 = blocked.
  sub-iter start <id> <label> Open a new in-skill sub-iteration entry
  sub-iter complete <id>      Close the most recent open sub-iteration (--summary "...")

Repository selection:
  --repo <name>               Required for pr helpers and pipeline update in workspace mode
                              (including one-repo workspaces); optional in legacy mode

Global flags:
  -h, --help                  Print this message
  -v, --version               Print version

Run 'redqueen <command> --help' for command-specific help.
`;

const COMMAND_HELP: Record<string, string> = {
  migrate: `redqueen migrate — Move a single-repo install up one directory into a workspace
Run at the git root containing redqueen.yaml, with project.directory resolving there.
Stop the orchestrator/service first. The parent must have no redqueen.yaml, .redqueen, or .env.
Requires git >= 2.17. Registered worktrees are moved through Git, including dirty work.
An installed enabled service is reinstalled and started after migration; a disabled one is uninstalled.
Options:
  --dry-run         Print and validate the migration without changing files or services
  -y, --yes         Migrate without the confirmation prompt
`,
  init: `redqueen init — Scaffold a project in a git repo or a folder of git repos (workspace)
Options:
  -y, --yes          Accept all defaults and include every discovered repo (non-interactive)
  --force            Overwrite existing redqueen.yaml
  --map-only         Regenerate .redqueen/codebase-map.md, preserving edit-me blocks
  --add-repo <path>   Append a repo to an existing workspace (or convert a single-repo install in place)
`,
  start: `redqueen start — Run the orchestrator in the foreground
Options:
  --verbose        Emit heartbeats and task events to stdout
  --quiet          Suppress the startup banner
`,
  stop: `redqueen stop — Stop a running orchestrator
Sends SIGTERM, waits for graceful shutdown, escalates to SIGKILL on timeout.
`,
  status: `redqueen status — Show orchestrator status
Options:
  --json           Emit single-line JSON
`,
  service: `redqueen service — Manage the background daemon
Subcommands:
  install          Install and enable the service (writes plist/unit + wrapper)
  start            Start the service
  stop             Stop the service
  restart          Restart the service
  status           Show install/run state and log paths
  uninstall        Stop, disable, and remove the service
`,
  jira: `redqueen jira — Jira helper commands
Subcommands:
  discover         Auto-fill customFields and phaseMapping by querying Jira

Options for 'discover':
  -y, --yes        Apply without prompting (CI-friendly)
  --dry-run        Print the proposed diff; never write
`,
};

export function printHelp(command?: string): void {
  if (command !== undefined && Object.prototype.hasOwnProperty.call(COMMAND_HELP, command)) {
    process.stdout.write(COMMAND_HELP[command] ?? HELP_TEXT);
    return;
  }
  process.stdout.write(HELP_TEXT);
}

export function printVersion(): void {
  process.stdout.write(
    `redqueen ${packageVersion()} (preview — see https://github.com/odyth/red-queen)\n`,
  );
}

export function getVersion(): string {
  return packageVersion();
}
