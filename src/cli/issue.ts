import { mkdirSync, existsSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { loadCliContext } from "./context.js";
import { CliError } from "./errors.js";
import { readBodyFromStdinOrFlag, writeJson } from "./io.js";

export async function cmdIssue(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "get":
      await cmdIssueGet(rest);
      return;
    case "comment":
      await cmdIssueComment(rest);
      return;
    case "comments":
      await cmdIssueComments(rest);
      return;
    case "attachments":
      await cmdIssueAttachments(rest);
      return;
    default:
      throw new CliError(
        `Unknown 'issue' subcommand: ${subcommand ?? "(missing)"}. Valid: get, comment, comments, attachments.`,
      );
  }
}

async function cmdIssueGet(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: { pretty: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("issue get: <id> is required");
  }
  const ctx = loadCliContext();
  try {
    const issue = await ctx.issueTracker.getIssue(issueId);
    writeJson(issue, values.pretty === true);
  } finally {
    ctx.cleanup();
  }
}

async function cmdIssueComment(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: { body: { type: "string" } },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("issue comment: <id> is required");
  }
  const body = await readBodyFromStdinOrFlag(values.body, "comment body");
  const ctx = loadCliContext();
  try {
    await ctx.issueTracker.addComment(issueId, body);
    ctx.audit.log({
      component: "helper:issue",
      issueId,
      message: "Posted comment via redqueen issue comment",
      metadata: { length: body.length },
    });
    writeJson({ ok: true });
  } finally {
    ctx.cleanup();
  }
}

async function cmdIssueComments(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: { pretty: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("issue comments: <id> is required");
  }
  const ctx = loadCliContext();
  try {
    const comments = await ctx.issueTracker.getComments(issueId);
    writeJson(comments, values.pretty === true);
  } finally {
    ctx.cleanup();
  }
}

async function cmdIssueAttachments(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const issueId = positionals[0];
  if (issueId === undefined) {
    throw new CliError("issue attachments: <id> is required");
  }
  const ctx = loadCliContext();
  try {
    const defaultDir = resolve(ctx.config.project.directory, ".redqueen", "attachments", issueId);
    const destDir = values.dir !== undefined ? resolve(values.dir) : defaultDir;
    if (existsSync(destDir) === false) {
      mkdirSync(destDir, { recursive: true });
    }

    const attachments = await ctx.issueTracker.listAttachments(issueId);
    const resolvedDestDir = resolve(destDir);
    for (const att of attachments) {
      const safeName = sanitizeAttachmentFilename(att.filename);
      if (safeName === null) {
        att.localPath = null;
        ctx.audit.log({
          component: "helper:issue",
          issueId,
          message: `Attachment ${att.id} rejected: unsafe filename`,
          metadata: { attachmentId: att.id, filename: att.filename },
        });
        continue;
      }
      const localPath = resolve(resolvedDestDir, safeName);
      if (localPath.startsWith(resolvedDestDir + sep) === false && localPath !== resolvedDestDir) {
        att.localPath = null;
        ctx.audit.log({
          component: "helper:issue",
          issueId,
          message: `Attachment ${att.id} rejected: path escapes destination directory`,
          metadata: { attachmentId: att.id, filename: att.filename },
        });
        continue;
      }
      try {
        await ctx.issueTracker.downloadAttachment(att, localPath);
        att.localPath = localPath;
      } catch (err) {
        att.localPath = null;
        ctx.audit.log({
          component: "helper:issue",
          issueId,
          message: `Attachment ${att.id} download failed: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { attachmentId: att.id, filename: att.filename },
        });
      }
    }
    writeJson(attachments, values.pretty === true);
  } finally {
    ctx.cleanup();
  }
}

function sanitizeAttachmentFilename(raw: string): string | null {
  if (raw.length === 0) {
    return null;
  }
  if (raw.includes("\0")) {
    return null;
  }
  const base = basename(raw);
  if (base.length === 0 || base === "." || base === "..") {
    return null;
  }
  if (base.startsWith(".")) {
    return null;
  }
  if (base.includes("/") || base.includes("\\")) {
    return null;
  }
  return base;
}
