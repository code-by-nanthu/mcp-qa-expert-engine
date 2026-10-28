/**
 * Command sanitizer — defense in depth over shell-free execution (PRD section 4).
 */

import path from "node:path";
import { MAX_COMMAND_CHARS } from "../config.js";
import { ToolInputError } from "../errors.js";
import { assertWithinWorkspace } from "./workspace.js";

const FORBIDDEN_CHARS = [";", "&", "|", "`", "$", "<", ">", "(", ")", "\n", "\r", "\0", "\\"];


const ALLOWED_COMMAND_HEADS = new Set([
  "npm", "npx", "yarn", "pnpm", "bun", "node",
  "python", "python3", "pytest",
  "jest", "vitest", "mocha", "playwright", "cypress",
]);


const DESTRUCTIVE_TOKENS = new Set([
  "rm", "rmdir", "del", "sudo", "su", "doas", "chmod", "chown", "chgrp",
  "dd", "mkfs", "mount", "umount", "curl", "wget", "nc", "netcat", "telnet",
  "ssh", "scp", "sftp", "eval", "exec", "source", "shutdown", "reboot",
  "halt", "poweroff", "kill", "killall", "pkill", "mv", "truncate", "shred",
  "crontab", "chroot", "systemctl", "launchctl",
]);


/** Shell-free tokenizer. Honours single/double quotes; performs no expansion. */
function tokenizeCommand(command) {
  const tokens = [];
  let current = "";
  let started = false;
  let quote = null;

  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }

  if (quote) {
    throw new ToolInputError("Unbalanced quote in command string.");
  }
  if (started) tokens.push(current);

  return tokens;
}


/**
 * Validates a test command and returns the argv pieces for execFile.
 * Throws ToolInputError with a precise reason on every rejection path.
 */
function assertSafeCommand(command) {
  if (command.length > MAX_COMMAND_CHARS) {
    throw new ToolInputError(
      `Command exceeds the ${MAX_COMMAND_CHARS}-character limit.`,
      { limit: MAX_COMMAND_CHARS, received: command.length }
    );
  }

  for (const ch of FORBIDDEN_CHARS) {
    if (command.includes(ch)) {
      const label = ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\0" ? "\\0" : ch;
      throw new ToolInputError(
        `Command rejected: shell metacharacter "${label}" is not permitted.`,
        {
          reason: "shell_metacharacter",
          character: label,
          hint: "Chained or substituted commands are blocked. Submit a single test command.",
        }
      );
    }
  }

  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    throw new ToolInputError("Command rejected: no executable token found.");
  }

  const head = path.basename(tokens[0]).toLowerCase();
  if (!ALLOWED_COMMAND_HEADS.has(head)) {
    throw new ToolInputError(
      `Command rejected: "${tokens[0]}" is not an approved test runner.`,
      {
        reason: "disallowed_executable",
        allowed: [...ALLOWED_COMMAND_HEADS].sort(),
      }
    );
  }

  for (const token of tokens) {
    const bare = path.basename(token).toLowerCase();
    if (DESTRUCTIVE_TOKENS.has(bare)) {
      throw new ToolInputError(
        `Command rejected: destructive token "${token}" detected.`,
        { reason: "destructive_token", token }
      );
    }
  }

  // Confine any path-shaped argument to the workspace (PRD section 5).
  for (const token of tokens.slice(1)) {
    const candidate = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
    if (!candidate) continue;
    const looksLikePath =
      candidate.startsWith("/") || candidate.startsWith("~") || candidate.includes("..");
    if (looksLikePath) {
      assertWithinWorkspace(candidate, "command argument");
    }
  }

  return { file: tokens[0], args: tokens.slice(1), tokens };
}

export {
  assertSafeCommand,
};
