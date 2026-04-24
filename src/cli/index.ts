#!/usr/bin/env node
import { CliError } from "./errors.js";
import { printHelp, printVersion } from "./help.js";
import { cmdInit } from "./init.js";
import { cmdStart } from "./start.js";
import { cmdStop } from "./stop.js";
import { cmdStatus } from "./status.js";
import { cmdIssue } from "./issue.js";
import { cmdSpec } from "./spec.js";
import { cmdPr } from "./pr.js";
import { cmdPipeline } from "./pipeline.js";

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-v") {
    printVersion();
    return;
  }

  switch (command) {
    case "init":
      await cmdInit(rest);
      return;
    case "start":
      await cmdStart(rest);
      return;
    case "stop":
      await cmdStop(rest);
      return;
    case "status":
      await cmdStatus(rest);
      return;
    case "issue":
      await cmdIssue(rest);
      return;
    case "spec":
      await cmdSpec(rest);
      return;
    case "pr":
      await cmdPr(rest);
      return;
    case "pipeline":
      await cmdPipeline(rest);
      return;
    default:
      throw new CliError(`Unknown command: ${command}. Run 'redqueen --help' for usage.`);
  }
}

main(process.argv.slice(2)).then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    if (err instanceof CliError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(err.exitCode);
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(2);
  },
);
