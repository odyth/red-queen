const VERSION = "0.1.0";

const HELP_TEXT = `Red Queen v${VERSION} — deterministic orchestrator for AI coding agents

Usage:
  redqueen <command> [options]

Top-level commands:
  init                        Scaffold a new Red Queen project in the current directory
  start                       Start the orchestrator (foreground)
  stop                        Stop a running orchestrator
  status                      Show orchestrator status

Helper commands (called by skills):
  issue get <id>              Fetch an issue as JSON
  issue comment <id>          Post a comment (--body or stdin)
  issue comments <id>         List comments as JSON
  issue attachments <id>      Download attachments (--dir <path>)
  spec get <id>               Print the stored spec
  spec set <id>               Set the spec (--body or stdin)
  pr create                   Create a PR (--issue --head --base --title, body via stdin)
  pr diff <number>            Print the PR diff
  pr checks <number>          Print CI check status (--wait <seconds>)
  pr review <number>          Post a review (--verdict, body via stdin)
  pr comments <number>        List review comments as JSON
  pr reply <number> <id>      Reply to a review comment (--body or stdin)
  pipeline update <issueId>   Update pipeline state (--branch --pr --worktree --clear-pr)
  pipeline cleanup <issueId>  Remove worktree and clear worktree path (--keep-branch)

Global flags:
  -h, --help                  Print this message
  -v, --version               Print version

Run 'redqueen <command> --help' for command-specific help.
`;

const COMMAND_HELP: Record<string, string> = {
  init: `redqueen init — Scaffold a new project
Options:
  -y, --yes        Accept all defaults (non-interactive)
  --force          Overwrite existing redqueen.yaml
  --map-only       Regenerate .redqueen/codebase-map.md only
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
};

export function printHelp(command?: string): void {
  if (command !== undefined && Object.prototype.hasOwnProperty.call(COMMAND_HELP, command)) {
    process.stdout.write(COMMAND_HELP[command] ?? HELP_TEXT);
    return;
  }
  process.stdout.write(HELP_TEXT);
}

export function printVersion(): void {
  process.stdout.write(`redqueen ${VERSION}\n`);
}

export function getVersion(): string {
  return VERSION;
}
