#!/usr/bin/env node
/**
 * Universal QA Expert Engine — MCP Server
 *
 * Exposes four QA tools over stdio JSON-RPC 2.0:
 *   1. generate_qa_matrix        — derives BVA vectors + EP buckets from code/requirements
 *   2. run_local_test_suite      — executes a sandboxed test command, returns the log stream
 *   3. parse_error_logs          — converts raw stack traces into structured defect records
 *   4. generate_automation_script — emits Page Object Model scaffolding per framework
 *
 * Protocol invariant: stdout carries protocol JSON only. Every diagnostic,
 * boot notice, and subprocess log goes to stderr or into a tool result payload.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/* ──────────────────────────────────────────────────────────────────────────
 * Limits
 * ────────────────────────────────────────────────────────────────────────── */

const MAX_INPUT_CHARS = 100_000;
const MAX_COMMAND_CHARS = 512;
const EXEC_TIMEOUT_MS = 300_000;
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;
const LOG_HEAD_LINES = 120;
const LOG_TAIL_LINES = 120;
const MAX_PARAMETERS = 40;
const MAX_FLOW_STEPS = 30;

/** Resolved once at boot; every path argument is confined beneath it. */
const WORKSPACE_ROOT = path.resolve(process.cwd());

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 2.3 — Input validation (hand-rolled, zero dependencies)
 * ────────────────────────────────────────────────────────────────────────── */

class ToolInputError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ToolInputError";
    this.details = details;
  }
}

/**
 * The MCP SDK does not enforce `inputSchema.required` at runtime, so every
 * handler validates its own arguments before touching them.
 */
function validateArgs(args, spec) {
  const provided = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const result = {};

  for (const [key, rule] of Object.entries(spec)) {
    const raw = provided[key];

    if (raw === undefined || raw === null) {
      if (rule.required) {
        throw new ToolInputError(`Missing required parameter "${key}".`, {
          parameter: key,
          expected: rule.enum ? `one of: ${rule.enum.join(", ")}` : rule.type || "string",
          received: raw === null ? "null" : "undefined",
        });
      }
      result[key] = rule.default;
      continue;
    }

    if (typeof raw !== "string") {
      throw new ToolInputError(`Parameter "${key}" must be a string.`, {
        parameter: key,
        expected: "string",
        received: Array.isArray(raw) ? "array" : typeof raw,
      });
    }

    const value = rule.preserveWhitespace ? raw : raw.trim();

    if (value.length === 0 && rule.required) {
      throw new ToolInputError(`Parameter "${key}" must not be empty.`, {
        parameter: key,
      });
    }

    const maxLength = rule.maxLength ?? MAX_INPUT_CHARS;
    if (value.length > maxLength) {
      throw new ToolInputError(
        `Parameter "${key}" exceeds the ${maxLength}-character limit.`,
        { parameter: key, limit: maxLength, received: value.length }
      );
    }

    if (rule.enum && !rule.enum.includes(value)) {
      throw new ToolInputError(`Parameter "${key}" has an unsupported value.`, {
        parameter: key,
        allowed: rule.enum,
        received: value,
      });
    }

    result[key] = value;
  }

  return result;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 2.4 — Workspace boundary enforcement (PRD section 5)
 * ────────────────────────────────────────────────────────────────────────── */

function escapesRoot(root, target) {
  const rel = path.relative(root, target);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * Resolves `candidate` against the workspace root and rejects anything that
 * climbs out of it — including via symlink.
 */
function assertWithinWorkspace(candidate, label = "path") {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new ToolInputError(`Invalid ${label}: expected a non-empty string.`);
  }
  if (candidate.includes("\0")) {
    throw new ToolInputError(`Invalid ${label}: null byte detected.`);
  }

  const resolved = path.resolve(WORKSPACE_ROOT, candidate);

  if (escapesRoot(WORKSPACE_ROOT, resolved)) {
    throw new ToolInputError(
      `Blocked ${label} "${candidate}": resolves outside the workspace boundary.`,
      { workspaceRoot: WORKSPACE_ROOT, resolved }
    );
  }

  // Re-check after symlink resolution so a link inside the tree cannot point out of it.
  let realRoot;
  try {
    realRoot = fs.realpathSync(WORKSPACE_ROOT);
  } catch {
    realRoot = WORKSPACE_ROOT;
  }

  let realTarget = resolved;
  try {
    realTarget = fs.realpathSync(resolved);
  } catch {
    // Path does not exist yet; the lexical check above already covered it.
    return resolved;
  }

  if (escapesRoot(realRoot, realTarget)) {
    throw new ToolInputError(
      `Blocked ${label} "${candidate}": symlink escapes the workspace boundary.`,
      { workspaceRoot: realRoot, resolved: realTarget }
    );
  }

  return resolved;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 2.5 — Command sanitizer (PRD section 4, Tool 2 safety boundary)
 *
 * Defense in depth. Execution uses execFile with shell:false, so shell
 * metacharacters are already inert; this layer rejects them anyway so a
 * malicious command never reaches the process boundary in the first place.
 * ────────────────────────────────────────────────────────────────────────── */

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

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 2.6 — Result helpers
 *
 * Tool-level failures return isError:true content so the agent can read and
 * recover from them. Raw throws are reserved for genuine protocol faults.
 * ────────────────────────────────────────────────────────────────────────── */

function toolText(text) {
  return { content: [{ type: "text", text }] };
}

function toolJson(payload) {
  return toolText(JSON.stringify(payload, null, 2));
}

function toolError(message, details) {
  let text = message;
  if (details !== undefined) {
    const rendered =
      typeof details === "string" ? details : JSON.stringify(details, null, 2);
    text = `${message}\n\n${rendered}`;
  }
  return { content: [{ type: "text", text }], isError: true };
}

/** Collapses an oversized log to head + tail with an explicit marker. */
function truncateLog(text, headLines = LOG_HEAD_LINES, tailLines = LOG_TAIL_LINES) {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= headLines + tailLines) return text;
  const omitted = lines.length - headLines - tailLines;
  return [
    ...lines.slice(0, headLines),
    `\n[... ${omitted} lines truncated ...]\n`,
    ...lines.slice(-tailLines),
  ].join("\n");
}

function titleCase(value) {
  return value
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function pascalCase(value) {
  return titleCase(value).replace(/[^A-Za-z0-9]/g, "");
}

function kebabCase(value) {
  return titleCase(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function camelCase(value) {
  const pascal = pascalCase(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 3 — Tool 2: run_local_test_suite
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Executes a vetted command with execFile (shell:false) so shell injection is
 * structurally impossible — argv is passed as an array, never re-parsed.
 * Always resolves; the caller decides how to present failure.
 */
function runCommand(file, args) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      file,
      args,
      {
        cwd: WORKSPACE_ROOT,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        shell: false, // non-negotiable: no shell, no metacharacter interpretation
        windowsHide: true,
        env: { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        resolve({
          error,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          durationMs: Date.now() - startedAt,
        });
      }
    );
    // stdio is piped by default — never inherited — so subprocess output can
    // never leak into this server's stdout and corrupt the JSON-RPC stream.
  });
}

function classifyExecOutcome({ error }) {
  if (!error) return { status: "passed", exitCode: 0 };

  if (error.killed || error.signal === "SIGTERM") {
    return {
      status: "timeout",
      exitCode: null,
      signal: error.signal ?? "SIGTERM",
      note: `Execution exceeded the ${EXEC_TIMEOUT_MS / 1000}s limit and was terminated.`,
    };
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return {
      status: "output_overflow",
      exitCode: null,
      note: `Output exceeded the ${EXEC_MAX_BUFFER / (1024 * 1024)}MB buffer and was cut off.`,
    };
  }
  if (error.code === "ENOENT") {
    return {
      status: "not_found",
      exitCode: null,
      note: "Executable not found on PATH inside the workspace.",
    };
  }
  if (typeof error.code === "number") {
    return { status: "failed", exitCode: error.code };
  }
  return { status: "error", exitCode: null, note: error.message };
}

/** Pulls a headline count out of common runner summaries, best effort. */
function extractTestSummary(combined) {
  const patterns = [
    /Tests?:\s+.*$/m,                              // jest / vitest
    /^\s*\d+ (?:passing|failing).*$/m,             // mocha
    /=+\s*\d+ (?:passed|failed).*?=+\s*$/m,        // pytest
    /^\d+ passed.*$/m,
  ];
  for (const pattern of patterns) {
    const match = combined.match(pattern);
    if (match) return match[0].trim();
  }
  return null;
}

async function handleRunLocalTestSuite(args) {
  const { command } = validateArgs(args, {
    command: { required: true, maxLength: MAX_COMMAND_CHARS },
  });

  // Safety gate runs to completion before anything is executed.
  const { file, args: argv, tokens } = assertSafeCommand(command);

  const execution = await runCommand(file, argv);
  const outcome = classifyExecOutcome(execution);
  const combined = `${execution.stdout}\n${execution.stderr}`;
  const summary = extractTestSummary(combined);

  const sections = [
    "=== LOCAL TEST SUITE EXECUTION ===",
    `[Command]        ${tokens.join(" ")}`,
    `[Working Dir]    ${WORKSPACE_ROOT}`,
    `[Status]         ${outcome.status.toUpperCase()}`,
    `[Exit Code]      ${outcome.exitCode ?? "n/a"}`,
    `[Duration]       ${execution.durationMs}ms`,
  ];
  if (summary) sections.push(`[Runner Summary] ${summary}`);
  if (outcome.note) sections.push(`[Note]           ${outcome.note}`);

  sections.push(
    "",
    "--- STDOUT ---",
    truncateLog(execution.stdout).trim() || "(empty)",
    "",
    "--- STDERR ---",
    truncateLog(execution.stderr).trim() || "(empty)"
  );

  if (outcome.status === "passed") {
    return toolText(sections.join("\n"));
  }

  // A failing suite is a legitimate QA result, not a protocol fault: the full
  // captured log is returned so the agent can diagnose it.
  sections.push(
    "",
    "--- QA TRIAGE ---",
    outcome.status === "failed"
      ? "Suite ran to completion and reported failures. Feed the stderr block into parse_error_logs for a structured defect record."
      : "Suite did not complete. Verify the runner is installed and the command is correct."
  );
  return { content: [{ type: "text", text: sections.join("\n") }], isError: true };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 4 — Tool 3: parse_error_logs
 * ────────────────────────────────────────────────────────────────────────── */

const ERROR_SIGNATURES = [
  { re: /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT)\b/, category: "network", severity: "high" },
  { re: /\b(MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b|Cannot find module/i, category: "dependency", severity: "high" },
  { re: /\bERR_REQUIRE_ESM\b|Must use import to load ES Module/i, category: "dependency", severity: "high" },
  { re: /\b(EACCES|EPERM)\b|permission denied/i, category: "permission", severity: "high" },
  { re: /JavaScript heap out of memory|OutOfMemoryError|MemoryError/i, category: "resource", severity: "critical" },
  { re: /Segmentation fault|SIGSEGV|core dumped/i, category: "resource", severity: "critical" },
  { re: /\b(SyntaxError|IndentationError|ParseError)\b|Unexpected token/i, category: "syntax", severity: "high" },
  { re: /\b(AssertionError|expect\(|toBe\(|toEqual\(|assert\.)/, category: "assertion", severity: "medium" },
  { re: /\bTimeout\b.*exceeded|Exceeded timeout of|timed out after/i, category: "timeout", severity: "medium" },
  { re: /status (?:code )?(?:of )?5\d{2}\b|Internal Server Error/i, category: "network", severity: "high" },
  { re: /status (?:code )?(?:of )?4\d{2}\b|Unauthorized|Forbidden|Not Found/i, category: "network", severity: "medium" },
];

const FIX_VECTORS = [
  {
    re: /Cannot read propert(?:y|ies) of (undefined|null)(?: \(reading '([^']+)'\))?/,
    build: (m) => [
      `Guard the access before dereferencing${m[2] ? ` "${m[2]}"` : ""} — use optional chaining or an explicit null check.`,
      `Trace the producer: establish why the upstream value is ${m[1]} instead of a populated object.`,
      "Add a defensive default only after confirming the empty state is legitimate, not a masked bug.",
    ],
  },
  {
    re: /Cannot find module ['"]([^'"]+)['"]|MODULE_NOT_FOUND/,
    build: (m) => [
      m[1] ? `Install or restore the missing dependency "${m[1]}".` : "Install the missing dependency.",
      "Verify the import path casing — case-insensitive macOS filesystems mask this until CI runs on Linux.",
      "Confirm the package is in dependencies, not devDependencies, if it is needed at runtime.",
    ],
  },
  {
    re: /\b(ECONNREFUSED|ENOTFOUND)\b(?:[^\n]*?(\d{2,5}))?/,
    build: (m) => [
      `Confirm the dependent service is listening${m[2] ? ` on port ${m[2]}` : ""} before the suite starts.`,
      "Add a readiness probe or wait-for-port step to the test bootstrap.",
      "Check host resolution and that the test environment points at the right base URL.",
    ],
  },
  {
    re: /\b(ETIMEDOUT|Timeout|timed out)\b/i,
    build: () => [
      "Raise the runner timeout for this spec only, after confirming the operation is genuinely slow rather than hung.",
      "Audit for a missing await — an unresolved promise is the most common cause of a hang.",
      "Replace fixed sleeps with explicit wait-for-condition assertions.",
    ],
  },
  {
    re: /\b(TypeError|ValueError|NullPointerException|AttributeError)\b/,
    build: (m) => [
      `Add a type or null guard at the ${m[1]} origin frame identified below.`,
      "Validate the boundary contract — run generate_qa_matrix on the offending function to cover the null and type-mismatch partitions.",
    ],
  },
  {
    re: /\b(KeyError|IndexError|out of (?:range|bounds))\b/i,
    build: () => [
      "Add a bounds or key-existence check before the lookup.",
      "Cover the empty-collection and off-by-one boundaries with explicit regression tests.",
    ],
  },
  {
    re: /\b(AssertionError)\b|expect\(|Expected:[\s\S]*Received:/,
    build: () => [
      "Compare the Expected vs Received values below and decide whether the assertion or the implementation is wrong.",
      "If the expectation changed intentionally, update the fixture and document the contract change.",
    ],
  },
  {
    re: /\b(SyntaxError|IndentationError)\b|Unexpected token/,
    build: () => [
      "Fix the syntax at the reported file and line.",
      "Confirm the module system matches the file extension (ESM .mjs / type:module vs CJS .cjs).",
    ],
  },
  {
    re: /heap out of memory|OutOfMemoryError/i,
    build: () => [
      "Raise the heap ceiling via NODE_OPTIONS=--max-old-space-size as a stopgap only.",
      "Profile for the real leak — unbounded caches and retained listeners are the usual causes.",
      "Shard the suite so a single worker is not holding the whole fixture set.",
    ],
  },
];

/** Strips ANSI colour codes so pattern matching is not defeated by formatting. */
const ANSI_PATTERN = new RegExp("\\u001b\\[[0-9;]*[A-Za-z]", "g");
function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, "");
}

function detectLanguage(logs) {
  if (/Traceback \(most recent call last\)|File "[^"]+", line \d+/.test(logs)) return "python";
  if (/\bat [\w.$]+\([\w$]+\.java:\d+\)|java\.lang\./.test(logs)) return "java";
  if (/\bat .*\(?(?:\/|[A-Za-z]:\\|https?:\/\/).*:\d+:\d+\)?/.test(logs)) return "javascript";
  if (/goroutine \d+ \[|^panic:/m.test(logs)) return "go";
  if (/thread '.*' panicked at/.test(logs)) return "rust";
  return "unknown";
}

function extractErrorClass(logs) {
  const candidates = [
    /^\s*(?:Uncaught\s+)?([A-Z][\w.]*(?:Error|Exception))\s*:\s*(.+)$/m,
    /^([a-z][\w.]*\.[A-Z]\w*(?:Error|Exception))\s*:\s*(.+)$/m,
    /^\s*(panic)\s*:\s*(.+)$/m,
    /\b(E[A-Z]{4,})\b[:\s]+(.*)$/m,
  ];
  for (const re of candidates) {
    const match = logs.match(re);
    if (match) {
      return { errorClass: match[1].trim(), errorMessage: match[2].trim().slice(0, 500) };
    }
  }
  // Jest/Vitest assertion blocks carry no classic error class.
  if (/expect\(|Expected:[\s\S]*Received:/.test(logs)) {
    const line = logs.split("\n").find((l) => /expect\(|✕|FAIL/.test(l));
    return {
      errorClass: "AssertionError",
      errorMessage: (line ?? "Assertion failed").trim().slice(0, 500),
    };
  }
  return { errorClass: null, errorMessage: null };
}

const APP_CODE_EXCLUSIONS = /node_modules|\/internal\/|^node:|site-packages|\/usr\/lib|<anonymous>/;

function extractFrames(logs) {
  const frames = [];
  const seen = new Set();

  const push = (frame) => {
    const key = `${frame.file}:${frame.line}:${frame.column ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    frames.push(frame);
  };

  // JavaScript / TypeScript: "at fn (/path/file.js:12:5)" or "at /path/file.js:12:5"
  const jsFrame = /\bat\s+(?:(?:async\s+)?([\w.$<>[\]\s]+?)\s+)?\(?((?:[A-Za-z]:\\|\/|\.{1,2}\/|https?:\/\/|node:|webpack:)[^\s)]+?):(\d+):(\d+)\)?/g;
  for (const m of logs.matchAll(jsFrame)) {
    push({
      symbol: (m[1] || "<anonymous>").trim(),
      file: m[2],
      line: Number(m[3]),
      column: Number(m[4]),
      isApplicationCode: !APP_CODE_EXCLUSIONS.test(m[2]),
    });
  }

  // Python: '  File "/path/x.py", line 12, in fn'
  const pyFrame = /File "([^"]+)", line (\d+)(?:, in (\S+))?/g;
  for (const m of logs.matchAll(pyFrame)) {
    push({
      symbol: m[3] || "<module>",
      file: m[1],
      line: Number(m[2]),
      column: null,
      isApplicationCode: !APP_CODE_EXCLUSIONS.test(m[1]),
    });
  }

  // Java: "at com.acme.Thing.method(Thing.java:12)"
  const javaFrame = /\bat\s+([\w.$]+)\(([\w$]+\.java):(\d+)\)/g;
  for (const m of logs.matchAll(javaFrame)) {
    push({
      symbol: m[1],
      file: m[2],
      line: Number(m[3]),
      column: null,
      isApplicationCode: !/^(java|javax|jdk|sun)\./.test(m[1]),
    });
  }

  return frames.slice(0, 25);
}

function extractAssertionDelta(logs) {
  const expected = logs.match(/^\s*(?:Expected|expected)(?: value)?:?\s*(.+)$/m);
  const received = logs.match(/^\s*(?:Received|received|Actual|actual):?\s*(.+)$/m);
  if (!expected && !received) return null;
  return {
    expected: expected ? expected[1].trim().slice(0, 300) : null,
    received: received ? received[1].trim().slice(0, 300) : null,
  };
}

function classifyError(logs, errorClass) {
  for (const sig of ERROR_SIGNATURES) {
    if (sig.re.test(logs)) return { category: sig.category, severity: sig.severity };
  }
  if (errorClass) return { category: "runtime", severity: "high" };
  return { category: "unknown", severity: "medium" };
}

function buildFixVectors(logs, errorClass) {
  const vectors = [];
  for (const entry of FIX_VECTORS) {
    const match = logs.match(entry.re);
    if (match) vectors.push(...entry.build(match));
    if (vectors.length >= 6) break;
  }
  if (vectors.length === 0) {
    vectors.push(
      errorClass
        ? `Locate the first application frame below and inspect the state feeding into the ${errorClass}.`
        : "No recognised error signature. Re-run the suite with verbose logging to capture a full stack trace."
    );
  }
  return vectors.slice(0, 6);
}

function buildReproSteps(logs, frames, category) {
  const steps = [];
  const commandHint = logs.match(
    /^\s*[$>]\s*((?:npm|npx|yarn|pnpm|pytest|jest|vitest|mocha|playwright)[^\n]*)$/m
  );

  steps.push(
    commandHint
      ? `Run "${commandHint[1].trim()}" from the workspace root.`
      : "Run the failing test suite from the workspace root."
  );

  const origin = frames.find((f) => f.isApplicationCode) ?? frames[0];
  if (origin) {
    steps.push(`Exercise the code path reaching ${origin.symbol} at ${origin.file}:${origin.line}.`);
  }
  if (category === "network") {
    steps.push("Ensure the dependent service/API is reachable from the test environment.");
  }
  if (category === "dependency") {
    steps.push("Reproduce against a clean install to confirm it is not stale local state.");
  }
  steps.push("Observe the error reproduced in the captured output below.");
  return steps;
}

/* ── Defect report enrichment (Manual-Testing.md section 3) ────────────── */

const DEFECT_FORMATS = ["json", "jira", "both"];

const EVIDENCE_BY_CATEGORY = {
  network: ["Network HAR export", "Request/response payload with headers", "Service-side log for the same correlation id"],
  dependency: ["Full install log", "Lockfile diff", "node_modules or site-packages listing for the affected package"],
  permission: ["Effective user and role", "File or resource ownership and mode", "Audit log entry for the denied operation"],
  resource: ["Heap snapshot or memory profile", "Process resource usage over time", "Container memory limit configuration"],
  syntax: ["Offending source file at the reported revision", "Build/transpiler configuration", "Runtime and module-system settings"],
  assertion: ["Full assertion diff (expected vs received)", "Test fixture used", "Screenshot at the point of failure"],
  timeout: ["Timeline of the operation", "Timeout configuration in effect", "Downstream service latency metrics"],
  runtime: ["Complete stack trace", "Input payload that triggered the fault", "Console output immediately before the error"],
  unknown: ["Complete raw log", "Steps the operator performed", "Screenshot or recording of the failure"],
};

const UNIVERSAL_EVIDENCE = [
  "Screenshot or screen recording of the failure",
  "Browser console output",
  "Build number and environment URL",
];

/** Pulls environment facts out of the log text; reports what is missing. */
function extractEnvironment(logs) {
  const env = {};

  let m;
  if ((m = logs.match(/\bNode(?:\.js)?\s+v?(\d+\.\d+\.\d+)/i))) env.runtime = `Node.js ${m[1]}`;
  else if ((m = logs.match(/\bv(\d+\.\d+\.\d+)\b/)) && /node/i.test(logs)) env.runtime = `Node.js ${m[1]}`;
  if ((m = logs.match(/\bPython\s+(\d+\.\d+(?:\.\d+)?)/i))) env.runtime = `Python ${m[1]}`;
  if ((m = logs.match(/\bjava version "?(\d+[\d._]*)/i))) env.runtime = `Java ${m[1]}`;

  if ((m = logs.match(/(Chrome|Firefox|Safari|Edge|Edg|OPR)\/(\d+[\d.]*)/))) {
    const name = m[1] === "Edg" ? "Edge" : m[1] === "OPR" ? "Opera" : m[1];
    env.browser = `${name} ${m[2]}`;
  }
  if ((m = logs.match(/Mozilla\/5\.0 \(([^)]+)\)/))) env.userAgentPlatform = m[1];

  if (/\bdarwin\b|Mac OS X|macOS/i.test(logs)) env.os = "macOS";
  else if (/\bwin32\b|Windows NT/i.test(logs)) env.os = "Windows";
  else if (/\blinux\b|Ubuntu|Debian|Alpine/i.test(logs)) env.os = "Linux";

  if ((m = logs.match(/\b(\d{3,4})\s*[x×]\s*(\d{3,4})\b/))) env.viewport = `${m[1]}x${m[2]}`;
  if ((m = logs.match(/https?:\/\/[^\s"')]+/))) env.url = m[0].slice(0, 200);
  if ((m = logs.match(/\bCI[=:]\s*(true|1)\b/i))) env.ci = true;

  const required = ["browser", "os", "viewport", "url", "runtime"];
  const missing = required.filter((k) => !(k in env));

  return {
    detected: env,
    missing,
    note: missing.length
      ? `Not present in the supplied logs: ${missing.join(", ")}. Capture these manually — a defect without environment specs is not reproducible.`
      : null,
  };
}

/** Best-effort component name from the first application frame. */
function deriveComponent(likelyOrigin) {
  if (!likelyOrigin?.file) return null;
  const base = likelyOrigin.file.split(/[/\\]/).filter(Boolean).pop() ?? "";
  const stem = base.replace(/\.(js|jsx|ts|tsx|mjs|cjs|py|java|go|rb|php)$/i, "");
  return stem ? titleCase(stem) : null;
}

function buildPreConditions(defect) {
  const conditions = ["Application is running at the build and environment recorded below"];
  if (defect.likelyOrigin) {
    conditions.push(`Execution reaches ${defect.likelyOrigin.symbol} in ${defect.likelyOrigin.file}`);
  }
  switch (defect.category) {
    case "network":
      conditions.push("Dependent service is reachable (or deliberately unavailable, if that is the trigger)");
      break;
    case "permission":
      conditions.push("Caller is authenticated with the role stated in the report");
      break;
    case "dependency":
      conditions.push("Dependencies installed from the committed lockfile");
      break;
    case "assertion":
      conditions.push("Test fixture and seed data are in the documented state");
      break;
    default:
      conditions.push("Input data matching the payload in Steps to Reproduce is present");
      break;
  }
  return conditions;
}

function buildEvidenceList(category) {
  return [...(EVIDENCE_BY_CATEGORY[category] ?? EVIDENCE_BY_CATEGORY.unknown), ...UNIVERSAL_EVIDENCE];
}

/** Renders the defect as Jira wiki markup, ready to paste into a ticket. */
function renderJiraReport(defect) {
  const lines = [];
  const env = defect.environment.detected;
  const envRows = Object.entries(env).map(([k, v]) => `| ${titleCase(k)} | ${v} |`);

  lines.push(
    `h2. ${defect.title}`,
    "",
    `*Defect ID:* ${defect.defectId}`,
    `*Severity:* ${defect.severity.toUpperCase()}`,
    `*Category:* ${defect.category}`,
    `*Component:* ${defect.component ?? "unassigned"}`,
    `*Reproducibility:* ${defect.reproducibility}`,
    `*Status:* ${defect.status}`,
    `*Parser confidence:* ${defect.confidence}`,
    "",
    "h3. Environment",
    ""
  );

  if (envRows.length) {
    lines.push("|| Field || Value ||", ...envRows);
  } else {
    lines.push("{panel:bgColor=#fffae6}No environment details were present in the supplied logs.{panel}");
  }
  if (defect.environment.note) {
    lines.push("", `{color:#de350b}*Missing:* ${defect.environment.note}{color}`);
  }

  lines.push(
    "",
    "h3. Pre-conditions",
    "",
    ...defect.preConditions.map((c) => `* ${c}`),
    "",
    "h3. Steps to Reproduce",
    "",
    ...defect.stepsToReproduce.map((s) => `# ${s}`),
    "",
    "h3. Expected Result",
    "",
    defect.assertionDelta?.expected
      ? defect.assertionDelta.expected
      : "The operation completes without error and the documented outcome is produced.",
    "",
    "h3. Actual Result",
    "",
    defect.assertionDelta?.received
      ? defect.assertionDelta.received
      : `${defect.errorClass}: ${defect.errorMessage ?? "see raw output below"}`,
    ""
  );

  if (defect.impactedSegments.length) {
    lines.push(
      "h3. Impacted Code",
      "",
      "|| File || Line || Symbol || Application Code ||",
      ...defect.impactedSegments
        .slice(0, 10)
        .map((s) => `| ${s.file} | ${s.line ?? "-"} | ${s.symbol} | ${s.isApplicationCode ? "yes" : "dependency"} |`),
      ""
    );
  }

  lines.push(
    "h3. Suggested Fix Vectors",
    "",
    ...defect.suggestedFixVectors.map((v) => `* ${v}`),
    "",
    "h3. Regression Coverage",
    "",
    ...defect.regressionTests.map((v) => `* ${v}`),
    "",
    "h3. Evidence Required",
    "",
    ...defect.evidenceRequired.map((v) => `* (/) ${v}`),
    "",
    "h3. Raw Output",
    "",
    "{code}",
    defect.rawExcerpt,
    "{code}"
  );

  return lines.join("\n");
}

function handleParseErrorLogs(args) {
  const { rawLogs, format } = validateArgs(args, {
    rawLogs: { required: true, preserveWhitespace: true },
    format: { required: false, enum: DEFECT_FORMATS, default: "json", maxLength: 16 },
  });

  const logs = stripAnsi(rawLogs);
  const { errorClass, errorMessage } = extractErrorClass(logs);
  const frames = extractFrames(logs);
  const language = detectLanguage(logs);
  const { category, severity } = classifyError(logs, errorClass);
  const assertionDelta = extractAssertionDelta(logs);

  // Stateless and deterministic: the same trace always yields the same id.
  const fingerprint = createHash("sha1")
    .update(`${errorClass ?? "unknown"}|${errorMessage ?? ""}|${frames[0]?.file ?? ""}|${frames[0]?.line ?? ""}`)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();

  const applicationFrames = frames.filter((f) => f.isApplicationCode);
  const likelyOrigin = applicationFrames[0] ?? frames[0] ?? null;

  let confidence = "low";
  if (errorClass && frames.length > 0) confidence = "high";
  else if (errorClass || frames.length > 0) confidence = "medium";

  const defect = {
    defectId: `DEF-${fingerprint}`,
    title: errorClass
      ? `${errorClass}: ${(errorMessage ?? "").slice(0, 120)}`.trim()
      : "Unclassified failure in captured output",
    errorClass: errorClass ?? "Unknown",
    errorMessage: errorMessage ?? null,
    category,
    severity,
    confidence,
    language,
    stepsToReproduce: buildReproSteps(logs, frames, category),
    impactedSegments: frames.map((f) => ({
      file: f.file,
      line: f.line,
      column: f.column,
      symbol: f.symbol,
      isApplicationCode: f.isApplicationCode,
    })),
    likelyOrigin: likelyOrigin
      ? {
          file: likelyOrigin.file,
          line: likelyOrigin.line,
          symbol: likelyOrigin.symbol,
          rationale: likelyOrigin.isApplicationCode
            ? "First stack frame resolving to application code rather than a dependency."
            : "No application frame present; this is the topmost frame available.",
        }
      : null,
    assertionDelta,
    component: deriveComponent(likelyOrigin),
    reproducibility: "Unconfirmed — re-run the exact steps above and record Always / Intermittent (n of 10) / Once",
    status: "New",
    environment: extractEnvironment(logs),
    suggestedFixVectors: buildFixVectors(logs, errorClass),
    regressionTests: [
      likelyOrigin
        ? `Add a unit test pinning the failing input at ${likelyOrigin.file}:${likelyOrigin.line}.`
        : "Add a unit test reproducing the failing input.",
      `Add a negative-path case covering the ${category} partition so this cannot regress silently.`,
    ],
    rawExcerpt: truncateLog(logs, 20, 20).trim().slice(0, 2000),
  };

  defect.preConditions = buildPreConditions(defect);
  defect.evidenceRequired = buildEvidenceList(category);

  if (confidence === "low") {
    defect.parserNote =
      "No recognised error class or stack frame was found. This is a partial record — supply the full stack trace for a complete analysis.";
  }

  if (format === "jira") return toolText(renderJiraReport(defect));
  if (format === "both") {
    return toolText(
      [
        renderJiraReport(defect),
        "",
        "---",
        "",
        "h3. Machine-readable record",
        "",
        "{code:json}",
        JSON.stringify(defect, null, 2),
        "{code}",
      ].join("\n")
    );
  }
  return toolJson(defect);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 5 — Tool 4: generate_automation_script
 * ────────────────────────────────────────────────────────────────────────── */

const SUPPORTED_FRAMEWORKS = ["playwright", "cypress", "jest"];

const ACTION_RULES = [
  { re: /\b(?:navigat\w*|visit\w*|go(?:es)? to|open\w*|land\w* on|browse\w*)\b/i, action: "navigate" },
  { re: /\b(?:log(?:s|ged)? ?in|sign(?:s|ed)? ?in|authenticat\w*)\b/i, action: "login" },
  { re: /\b(?:log(?:s|ged)? ?out|sign(?:s|ed)? ?out)\b/i, action: "logout" },
  { re: /\b(?:type\w*|enter\w*|fill\w*|input\w*|provid\w*|key\w* in)\b/i, action: "fill" },
  { re: /\b(?:select\w*|choos\w*|pick\w*)\b/i, action: "select" },
  { re: /\b(?:upload\w*|attach\w*)\b/i, action: "upload" },
  { re: /\b(?:check\w* the box|tick\w*|toggl\w*)\b/i, action: "check" },
  { re: /\b(?:verif\w*|assert\w*|confirm\w*|expect\w*|should|validat\w*|see\w*|display\w*)\b/i, action: "assert" },
  { re: /\b(?:click\w*|tap\w*|press\w*|submit\w*|add\w*|save\w*|creat\w*|delet\w*|remov\w*)\b/i, action: "click" },
  { re: /\b(?:wait\w*)\b/i, action: "wait" },
];

const STOPWORDS = new Set([
  "the", "a", "an", "to", "on", "in", "into", "and", "then", "with", "for",
  "of", "at", "user", "users", "page", "screen", "that", "their", "his",
  "her", "its", "is", "are", "be", "has", "have", "valid", "new", "it",
]);

/** Splits a free-form flow description into ordered, de-noised steps. */
function splitFlowSteps(flowDescription) {
  const normalized = flowDescription
    .replace(/\r/g, "")
    .replace(/^\s*\d+[.)]\s*/gm, "\n")
    .replace(/\s*\bthen\b\s*/gi, "\n")
    .replace(/\s*\band then\b\s*/gi, "\n")
    .replace(/[,;]\s*/g, "\n")
    .replace(/^\s*[-*+]\s*/gm, "\n");

  return normalized
    .split("\n")
    .map((s) => s.trim().replace(/^and\s+/i, "").replace(/\.$/, "").trim())
    .filter((s) => s.length > 2)
    .slice(0, MAX_FLOW_STEPS);
}

function detectAction(step) {
  for (const rule of ACTION_RULES) {
    if (rule.re.test(step)) return rule.action;
  }
  return "click";
}

/** Derives a stable element name from the meaningful nouns in a step. */
function deriveTargetName(step, action, index) {
  const words = step
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));

  // Drop the leading verb so "clicks the save button" yields "save button".
  const verbless = words.length > 1 ? words.slice(1) : words;
  const picked = (verbless.length ? verbless : words).slice(0, 3);
  if (picked.length === 0) return `${action}Target${index + 1}`;
  return picked.join(" ");
}

function buildFlowSteps(flowDescription) {
  const raw = splitFlowSteps(flowDescription);
  const source = raw.length > 0 ? raw : [flowDescription];

  return source.map((text, index) => {
    const action = detectAction(text);
    const target = deriveTargetName(text, action, index);
    const slug = kebabCase(target) || `step-${index + 1}`;
    return {
      index: index + 1,
      text,
      action,
      target,
      testId: slug,
      locator: camelCase(target) || `target${index + 1}`,
      method: camelCase(`${action} ${target}`) || `step${index + 1}`,
    };
  });
}

/** Verbs describe the action; the flow is named after what it acts on. */
const ACTION_VERBS = new Set([
  "log", "logs", "logged", "login", "sign", "signs", "visit", "visits", "visited",
  "enter", "enters", "entered", "click", "clicks", "clicked", "tap", "taps",
  "add", "adds", "added", "verify", "verifies", "verified", "navigate", "navigates",
  "open", "opens", "opened", "submit", "submits", "submitted", "select", "selects",
  "type", "types", "typed", "fill", "fills", "filled", "check", "checks", "checked",
  "go", "goes", "went", "see", "sees", "saw", "view", "views", "viewed",
  "upload", "uploads", "download", "downloads", "save", "saves", "create", "creates",
  "update", "updates", "delete", "deletes", "remove", "removes", "search", "searches",
  "confirm", "confirms", "choose", "chooses", "press", "presses", "lands",
]);

function deriveFlowName(flowDescription) {
  const significant = flowDescription
    .replace(/[^A-Za-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w.toLowerCase()));

  const nouns = significant.filter((w) => !ACTION_VERBS.has(w.toLowerCase()));
  const words = (nouns.length ? nouns : significant).slice(0, 3);
  const base = words.length ? words.join(" ") : "Primary Flow";
  return pascalCase(base) || "PrimaryFlow";
}

/** Shared placeholder-value logic so all three emitters stay consistent. */
function sampleValueFor(step) {
  if (/^id$|Id$|uuid|guid/i.test(step.target)) return "11111111-2222-4333-8444-555555555555";
  if (/email/i.test(step.target)) return "qa.user@example.com";
  if (/password/i.test(step.target)) return "Str0ng!Passw0rd";
  if (/card|number/i.test(step.target)) return "4242424242424242";
  if (/cvv|cvc/i.test(step.target)) return "123";
  if (/expiry|expiration|date/i.test(step.target)) return "12/34";
  if (/name/i.test(step.target)) return "QA Automation";
  return `sample ${step.target}`;
}

function emitPlaywright(flowName, steps, flowDescription) {
  const pageClass = `${flowName}Page`;
  const fileSlug = kebabCase(flowName);

  const locators = steps
    .map((s) => `    this.${s.locator} = page.getByTestId("${s.testId}");`)
    .join("\n");

  const methods = steps
    .map((s) => {
      const body = {
        navigate: `    await this.page.goto("/${fileSlug}");`,
        login: `    await this.page.getByTestId("email").fill(credentials.email);\n    await this.page.getByTestId("password").fill(credentials.password);\n    await this.page.getByTestId("submit").click();\n    await this.page.waitForURL("**/dashboard");`,
        logout: `    await this.${s.locator}.click();\n    await this.page.waitForURL("**/login");`,
        fill: `    await this.${s.locator}.fill(value);`,
        select: `    await this.${s.locator}.selectOption(value);`,
        upload: `    await this.${s.locator}.setInputFiles(filePath);`,
        check: `    await this.${s.locator}.check();`,
        wait: `    await this.${s.locator}.waitFor({ state: "visible" });`,
        assert: `    await expect(this.${s.locator}).toBeVisible();`,
        click: `    await this.${s.locator}.click();`,
      }[s.action];

      const signature = {
        login: "credentials",
        fill: "value",
        select: "value",
        upload: "filePath",
      }[s.action] ?? "";

      return `  /** Step ${s.index}: ${s.text} */\n  async ${s.method}(${signature}) {\n${body}\n  }`;
    })
    .join("\n\n");

  const calls = steps
    .map((s) => {
      const arg = {
        login: `{ email: "${sampleValueFor({ target: "email" })}", password: "${sampleValueFor({ target: "password" })}" }`,
        fill: `"${sampleValueFor(s)}"`,
        select: `"${sampleValueFor(s)}"`,
        upload: `"fixtures/sample.png"`,
      }[s.action] ?? "";
      return `    await ${camelCase(pageClass)}.${s.method}(${arg});`;
    })
    .join("\n");

  return `// ─── file: pages/${pageClass}.js ───────────────────────────────────
import { expect } from "@playwright/test";

/**
 * Page Object Model — ${flowName}
 * Flow: ${flowDescription}
 */
export class ${pageClass} {
  constructor(page) {
    this.page = page;
${locators}
  }

${methods}
}

// ─── file: tests/${fileSlug}.spec.js ───────────────────────────────
import { test, expect } from "@playwright/test";
import { ${pageClass} } from "../pages/${pageClass}.js";

test.describe("${flowName}", () => {
  let ${camelCase(pageClass)};

  test.beforeEach(async ({ page }) => {
    ${camelCase(pageClass)} = new ${pageClass}(page);
  });

  test("happy path: ${flowDescription.slice(0, 80)}", async ({ page }) => {
${calls}
  });

  test("negative path: rejects invalid input", async ({ page }) => {
    // TODO: drive the invalid Equivalence Partition from generate_qa_matrix here.
    test.fixme(true, "Populate from the EP invalid-class bucket.");
  });
});
`;
}

function emitCypress(flowName, steps, flowDescription) {
  const pageClass = `${flowName}Page`;
  const fileSlug = kebabCase(flowName);

  const getters = steps
    .map((s) => `  get ${s.locator}() {\n    return cy.get('[data-testid="${s.testId}"]');\n  }`)
    .join("\n\n");

  const methods = steps
    .map((s) => {
      const body = {
        navigate: `    cy.visit("/${fileSlug}");`,
        login: `    cy.get('[data-testid="email"]').type(credentials.email);\n    cy.get('[data-testid="password"]').type(credentials.password, { log: false });\n    cy.get('[data-testid="submit"]').click();\n    cy.url().should("include", "/dashboard");`,
        logout: `    this.${s.locator}.click();\n    cy.url().should("include", "/login");`,
        fill: `    this.${s.locator}.clear().type(value);`,
        select: `    this.${s.locator}.select(value);`,
        upload: `    this.${s.locator}.selectFile(filePath);`,
        check: `    this.${s.locator}.check();`,
        wait: `    this.${s.locator}.should("be.visible");`,
        assert: `    this.${s.locator}.should("be.visible");`,
        click: `    this.${s.locator}.click();`,
      }[s.action];

      const signature = {
        login: "credentials",
        fill: "value",
        select: "value",
        upload: "filePath",
      }[s.action] ?? "";

      return `  /** Step ${s.index}: ${s.text} */\n  ${s.method}(${signature}) {\n${body}\n    return this;\n  }`;
    })
    .join("\n\n");

  const calls = steps
    .map((s) => {
      const arg = {
        login: `{ email: "${sampleValueFor({ target: "email" })}", password: "${sampleValueFor({ target: "password" })}" }`,
        fill: `"${sampleValueFor(s)}"`,
        select: `"${sampleValueFor(s)}"`,
        upload: `"cypress/fixtures/sample.png"`,
      }[s.action] ?? "";
      return `    ${camelCase(pageClass)}.${s.method}(${arg});`;
    })
    .join("\n");

  return `// ─── file: cypress/pages/${pageClass}.js ───────────────────────────
/**
 * Page Object Model — ${flowName}
 * Flow: ${flowDescription}
 */
class ${pageClass} {
${getters}

${methods}
}

export default new ${pageClass}();

// ─── file: cypress/e2e/${fileSlug}.cy.js ───────────────────────────
import ${camelCase(pageClass)} from "../pages/${pageClass}.js";

describe("${flowName}", () => {
  beforeEach(() => {
    cy.clearCookies();
    cy.clearLocalStorage();
  });

  it("happy path: ${flowDescription.slice(0, 80)}", () => {
${calls}
  });

  it("negative path: rejects invalid input", () => {
    // TODO: drive the invalid Equivalence Partition from generate_qa_matrix here.
    cy.log("Populate from the EP invalid-class bucket.");
  });
});
`;
}

function emitJest(flowName, steps, flowDescription) {
  const pageClass = `${flowName}Screen`;
  const fileSlug = kebabCase(flowName);

  const getters = steps
    .map((s) => `  get ${s.locator}() {\n    return screen.getByTestId("${s.testId}");\n  }`)
    .join("\n\n");

  const methods = steps
    .map((s) => {
      const body = {
        navigate: `    render(<${flowName} />);`,
        login: `    await this.user.type(screen.getByTestId("email"), credentials.email);\n    await this.user.type(screen.getByTestId("password"), credentials.password);\n    await this.user.click(screen.getByTestId("submit"));`,
        logout: `    await this.user.click(this.${s.locator});`,
        fill: `    await this.user.clear(this.${s.locator});\n    await this.user.type(this.${s.locator}, value);`,
        select: `    await this.user.selectOptions(this.${s.locator}, value);`,
        upload: `    await this.user.upload(this.${s.locator}, file);`,
        check: `    await this.user.click(this.${s.locator});`,
        wait: `    await waitFor(() => expect(this.${s.locator}).toBeVisible());`,
        assert: `    expect(this.${s.locator}).toBeVisible();`,
        click: `    await this.user.click(this.${s.locator});`,
      }[s.action];

      const signature = {
        login: "credentials",
        fill: "value",
        select: "value",
        upload: "file",
      }[s.action] ?? "";

      const isAsync = s.action !== "assert";
      return `  /** Step ${s.index}: ${s.text} */\n  ${isAsync ? "async " : ""}${s.method}(${signature}) {\n${body}\n  }`;
    })
    .join("\n\n");

  const calls = steps
    .map((s) => {
      const arg = {
        login: `{ email: "${sampleValueFor({ target: "email" })}", password: "${sampleValueFor({ target: "password" })}" }`,
        fill: `"${sampleValueFor(s)}"`,
        select: `"${sampleValueFor(s)}"`,
        upload: `new File(["x"], "sample.png", { type: "image/png" })`,
      }[s.action] ?? "";
      const isAsync = s.action !== "assert";
      return `    ${isAsync ? "await " : ""}${camelCase(pageClass)}.${s.method}(${arg});`;
    })
    .join("\n");

  return `// ─── file: __tests__/pages/${pageClass}.js ─────────────────────────
import { screen, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Page Object Model — ${flowName}
 * Flow: ${flowDescription}
 */
export class ${pageClass} {
  constructor() {
    this.user = userEvent.setup();
  }

${getters}

${methods}
}

// ─── file: __tests__/${fileSlug}.test.js ───────────────────────────
/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { ${pageClass} } from "./pages/${pageClass}.js";

describe("${flowName}", () => {
  let ${camelCase(pageClass)};

  beforeEach(() => {
    jest.clearAllMocks();
    ${camelCase(pageClass)} = new ${pageClass}();
  });

  it("happy path: ${flowDescription.slice(0, 80)}", async () => {
${calls}
  });

  it("negative path: rejects invalid input", async () => {
    // TODO: drive the invalid Equivalence Partition from generate_qa_matrix here.
    expect(true).toBe(true);
  });
});
`;
}

const FRAMEWORK_EMITTERS = {
  playwright: emitPlaywright,
  cypress: emitCypress,
  jest: emitJest,
};

const COVERAGE_LEVELS = ["functional", "full"];

function handleGenerateAutomationScript(args) {
  const { framework, flowDescription, coverage } = validateArgs(args, {
    framework: { required: true, enum: SUPPORTED_FRAMEWORKS, maxLength: 32 },
    flowDescription: { required: true, maxLength: 4000 },
    coverage: { required: false, enum: COVERAGE_LEVELS, default: "full", maxLength: 32 },
  });

  const flowName = deriveFlowName(flowDescription);
  const steps = buildFlowSteps(flowDescription);
  const fileSlug = kebabCase(flowName);
  const emit = FRAMEWORK_EMITTERS[framework];

  const emitted = ["Page Object Model + functional spec"];
  const blocks = [emit(flowName, steps, flowDescription)];

  if (coverage === "full") {
    blocks.push(
      emitDataDriven(framework, flowName, steps, fileSlug),
      emitResponsive(framework, flowName, steps, fileSlug),
      emitUiStates(framework, flowName, steps, fileSlug),
      emitAccessibility(framework, flowName, fileSlug),
      emitBdd(flowName, steps, flowDescription, fileSlug)
    );
    emitted.push(
      "data-driven spec",
      "responsive + visual regression spec",
      "component state spec",
      "accessibility spec",
      "BDD feature file"
    );
  }

  const header = [
    `// Framework : ${framework}`,
    `// Flow      : ${flowDescription}`,
    `// Steps     : ${steps.length} derived`,
    `// Coverage  : ${coverage} — ${emitted.join(", ")}`,
    "// Selectors : data-testid based — align these with the application markup.",
    "// Waits     : explicit condition-based only; no fixed sleeps.",
    coverage === "functional"
      ? '// NOTE      : coverage "full" additionally emits data-driven, responsive/VRT,\n//             component-state, accessibility, and BDD artifacts.'
      : "",
    "",
  ]
    .filter(Boolean)
    .join("\n") + "\n\n";

  // PRD section 4 is explicit: Tool 4 returns plain text, not JSON.
  return toolText(header + blocks.join("\n"));
}

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 6 — Tool 1: generate_qa_matrix (dynamic, parameter-derived)
 * ────────────────────────────────────────────────────────────────────────── */

const RESERVED_WORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "const", "let",
  "var", "await", "typeof", "new", "do", "else", "try", "class", "import",
  "export", "throw", "yield", "delete", "void", "in", "of", "case", "default",
  "self", "cls", "this", "super", "constructor", "with", "lambda", "print",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Reduces a git diff to its post-change source so parsing sees real code. */
function normalizeSource(input) {
  const lines = input.split("\n");
  const isDiff = lines.some((l) => /^(diff --git |@@ |\+\+\+ |--- )/.test(l));
  if (!isDiff) return { source: input, inputKind: /^\s*[-*#]/m.test(input) ? "requirements" : "source" };

  const kept = [];
  for (const line of lines) {
    if (/^(diff --git |index |@@ |\+\+\+ |--- |new file|deleted file|similarity |rename |Binary files)/.test(line)) continue;
    if (line.startsWith("-")) continue; // removed lines are not the new contract
    kept.push(line.startsWith("+") ? line.slice(1) : line.replace(/^ /, ""));
  }
  return { source: kept.join("\n"), inputKind: "diff" };
}

/** Comma-splits a parameter list without breaking on nested generics or objects. */
function splitParamList(list) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function extractParameters(source) {
  const found = new Map();

  const add = (rawName, rawType, origin) => {
    const name = String(rawName).replace(/^\.\.\./, "").replace(/\?$/, "").trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
    if (RESERVED_WORDS.has(name) || RESERVED_WORDS.has(name.toLowerCase())) return;
    if (found.has(name)) {
      const existing = found.get(name);
      if (!existing.rawType && rawType) existing.rawType = rawType.trim();
      return;
    }
    if (found.size >= MAX_PARAMETERS) return;
    found.set(name, { name, rawType: rawType ? rawType.trim() : null, origin });
  };

  const ingestList = (list, origin) => {
    for (const part of splitParamList(list)) {
      // Destructured parameter: { a, b } or [a, b]
      const destructured = part.match(/^[{[]([^}\]]*)[}\]]/);
      if (destructured) {
        for (const inner of splitParamList(destructured[1])) {
          const key = inner.split(/[:=]/)[0].trim();
          add(key, null, `${origin} (destructured)`);
        }
        continue;
      }
      const m = part.match(/^([A-Za-z_$][\w$]*)\s*\??\s*(?::\s*([^=]+?))?\s*(?:=\s*.+)?$/);
      if (m) add(m[1], m[2], origin);
    }
  };

  // JS/TS function declarations and arrow functions.
  for (const m of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([\s\S]*?)\)/g)) {
    ingestList(m[2], `function ${m[1]}()`);
  }
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(([\s\S]*?)\)\s*=>/g)) {
    ingestList(m[2], `arrow ${m[1]}()`);
  }
  // Class / object methods.
  for (const m of source.matchAll(/(?:^|\n)\s*(?:public |private |protected |static |async )*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[\w<>[\]|\s]+)?\s*\{/g)) {
    if (RESERVED_WORDS.has(m[1])) continue;
    ingestList(m[2], `method ${m[1]}()`);
  }
  // Python definitions.
  for (const m of source.matchAll(/def\s+([A-Za-z_]\w*)\s*\(([\s\S]*?)\)\s*(?:->[^:]+)?:/g)) {
    ingestList(m[2], `def ${m[1]}()`);
  }

  // TypeScript interface / type / class field declarations.
  const TYPE_LIKE = /^(['"]|string|number|boolean|bigint|Date|any|unknown|object|symbol|null|undefined|Array|Record|Map|Set|Promise|int|float|str|bool|list|dict|[A-Z]\w*)/;
  for (const m of source.matchAll(/^[ \t]*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\??)\s*:\s*([A-Za-z_$'"][\w$<>[\]|'"., ]*?)\s*[;,]?\s*$/gm)) {
    const rawType = m[3].trim();
    if (!TYPE_LIKE.test(rawType)) continue;
    add(m[1], rawType, "type field");
  }

  // Markdown requirement bullets: "- age (integer, 18-120)" / "- **email**: must be valid"
  const DECLARED_TYPE = /\b(string|number|boolean|int|integer|float|double|decimal|date|datetime|timestamp|array|list|object|enum|uuid|text)\b/i;
  for (const m of source.matchAll(/^\s*[-*+]\s+(?:\*\*)?`?([A-Za-z_][\w]*)`?(?:\*\*)?\s*[:(]\s*(.+)$/gm)) {
    const declared = m[2].match(DECLARED_TYPE);
    add(m[1], declared ? declared[1] : null, "requirement bullet");
  }

  return [...found.values()];
}

/** Collects every line mentioning a parameter so constraints can be mined from it. */
function gatherContext(source, name) {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  return source
    .split("\n")
    .filter((l) => re.test(l))
    .slice(0, 15)
    .join("\n");
}

function extractConstraints(context, rawType) {
  const c = {};
  let m;

  if ((m = context.match(/\bmin(?:imum)?\s*(?:length|len|value|size)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i))) c.min = Number(m[1]);
  if ((m = context.match(/\bmax(?:imum)?\s*(?:length|len|value|size)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i))) c.max = Number(m[1]);
  if ((m = context.match(/\bbetween\s+(-?\d+)\s+and\s+(-?\d+)/i))) { c.min = Number(m[1]); c.max = Number(m[2]); }
  if ((m = context.match(/(-?\d+)\s*(?:-|–|to)\s*(-?\d+)/)) && c.min === undefined) { c.min = Number(m[1]); c.max = Number(m[2]); }
  if ((m = context.match(/>=\s*(-?\d+)/))) c.min = Number(m[1]);
  if ((m = context.match(/<=\s*(-?\d+)/))) c.max = Number(m[1]);
  if ((m = context.match(/>\s*(-?\d+)/)) && c.min === undefined) c.min = Number(m[1]) + 1;
  if ((m = context.match(/<\s*(-?\d+)/)) && c.max === undefined) c.max = Number(m[1]) - 1;
  if ((m = context.match(/\bmaxLength\D{0,5}(\d+)/i))) c.maxLength = Number(m[1]);
  if ((m = context.match(/\bminLength\D{0,5}(\d+)/i))) c.minLength = Number(m[1]);
  if ((m = context.match(/\.length\s*[<>]=?\s*(\d+)/))) c.maxLength = c.maxLength ?? Number(m[1]);
  if ((m = context.match(/\b(\d+)\s*(?:digits|characters|chars)\b/i))) {
    const exact = Number(m[1]);
    c.minLength = c.minLength ?? exact;
    c.maxLength = c.maxLength ?? exact;
  }

  if (/\b(required|mandatory|non-?null|not null|NOT NULL)\b/i.test(context)) c.required = true;
  if (/\b(optional|nullable|may be (?:null|omitted))\b/i.test(context) || /\?\s*:/.test(context)) c.optional = true;

  if ((m = context.match(/\bone of\s*[:\s]\s*([^.\n]+)/i))) {
    c.enum = m[1].split(/[,|/]/).map((s) => s.trim().replace(/^["'`]|["'`]$/g, "")).filter(Boolean).slice(0, 10);
  }
  if (rawType && rawType.includes("|") && /['"]/.test(rawType)) {
    const members = rawType.split("|").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
    if (members.length > 1) c.enum = members.slice(0, 10);
  }
  if (!c.enum) {
    // A quoted union written in a comment or docstring, e.g. 'active' | 'suspended'
    const union = context.match(/(?:['"][^'"\n]+['"]\s*\|\s*)+['"][^'"\n]+['"]/);
    if (union) {
      const members = union[0].split("|").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
      if (members.length > 1) c.enum = members.slice(0, 10);
    }
  }

  return c;
}

function inferType(name, rawType, constraints) {
  if (constraints.enum && constraints.enum.length > 1) return "enum";

  const t = (rawType ?? "").toLowerCase().trim();
  if (t) {
    if (/\[\]|^array|^list|^tuple|^set</.test(t)) return "array";
    if (/^(number|int|integer|float|double|long|decimal|bigint)\b/.test(t)) return "number";
    if (/^(string|str|text|char|uuid)\b/.test(t)) return "string";
    if (/^(bool|boolean)\b/.test(t)) return "boolean";
    if (/^(date|datetime|timestamp)\b/.test(t)) return "date";
    if (/^(object|dict|map|record|any|unknown)\b/.test(t)) return "object";
  }

  const n = name.toLowerCase();
  if (
    /^(is|has|can|should|will|does|did|allow|enable|require|auto|use|show|hide|skip|force|include|exclude|with|only)[A-Z_]/.test(name) ||
    /^(enabled|active|visible|disabled|flag|checked|required|optional)$/.test(n) ||
    /(enabled|disabled|visible|checked|flag)$/.test(n)
  ) return "boolean";
  if (/(count|amount|age|qty|quantity|price|total|index|size|length|num|score|rate|limit|offset|balance|weight|height|percent|retries|retry|attempt|tries|failure|strike|timeout|port|seat|day|week|month|year|level|priority|duration|quota|threshold)/.test(n)) return "number";
  if (/(date|time|expiry|expiration|dob|birthday|createdat|updatedat|deadline)/.test(n)) return "date";
  if (/(list|items|array|rows|records|collection|tags|ids)$/.test(n)) return "array";
  if (/(email|name|title|desc|text|url|token|password|phone|address|code|slug|message|label|path|query|key|id)/.test(n)) return "string";

  // Constraints observed in the source imply a shape even when the name does not.
  if (typeof constraints.min === "number" || typeof constraints.max === "number") return "number";
  if (typeof constraints.minLength === "number" || typeof constraints.maxLength === "number") return "string";
  return "unknown";
}

/** Format-aware extra vectors for well-known semantic field names. */
function formatVectors(name) {
  const n = name.toLowerCase();
  if (/email/.test(n)) {
    return [
      ['"user@example.com"', "format (valid)", "Accept"],
      ['"user@@example.com"', "format (double @)", "Reject"],
      ['"user@example"', "format (no TLD)", "Reject"],
      ['"@example.com"', "format (no local part)", "Reject"],
      ['"user+tag@example.co.uk"', "format (plus addressing)", "Accept: RFC-valid"],
    ];
  }
  if (/url|uri|endpoint/.test(n)) {
    return [
      ['"https://example.com/path"', "format (valid https)", "Accept"],
      ['"javascript:alert(1)"', "format (dangerous scheme)", "Reject"],
      ['"//example.com"', "format (protocol-relative)", "Reject or normalise explicitly"],
    ];
  }
  if (/password/.test(n)) {
    return [
      ['"Str0ng!Passw0rd"', "format (meets policy)", "Accept"],
      ['"password"', "format (common/weak)", "Reject per password policy"],
      ['" leading space"', "format (whitespace)", "Define trim policy explicitly"],
    ];
  }
  if (/phone|mobile/.test(n)) {
    return [
      ['"+447700900123"', "format (E.164)", "Accept"],
      ['"07700 900123"', "format (national, spaces)", "Normalise or reject explicitly"],
      ['"123"', "format (too short)", "Reject"],
    ];
  }
  return [];
}

function buildBvaVectors(param) {
  const { type, constraints: c, name } = param;
  const vectors = [];
  const push = (input, classification, expected) => vectors.push({ input, classification, expected });
  const nullExpect = c.optional ? "Accept: documented as optional" : "Reject: not documented as nullable";
  const undefExpect = c.required ? "Reject: parameter is required" : "Apply documented default";

  switch (type) {
    case "number": {
      if (typeof c.min === "number") {
        push(String(c.min - 1), "lower boundary (min - 1)", "Reject: below minimum");
        push(String(c.min), "lower boundary (min)", "Accept: minimum is inclusive");
        push(String(c.min + 1), "lower boundary (min + 1)", "Accept");
      } else {
        push("0", "lower boundary (zero)", "Define behaviour: zero may be valid or a sentinel");
        push("-1", "lower boundary (negative)", "Reject unless negatives are specified");
      }
      if (typeof c.max === "number") {
        push(String(c.max - 1), "upper boundary (max - 1)", "Accept");
        push(String(c.max), "upper boundary (max)", "Accept: maximum is inclusive");
        push(String(c.max + 1), "upper boundary (max + 1)", "Reject: exceeds maximum");
      } else {
        push("2147483647", "upper boundary (int32 max)", "Accept or reject explicitly — no silent overflow");
        push("9007199254740991", "upper boundary (MAX_SAFE_INTEGER)", "Accept");
        push("9007199254740992", "upper boundary (beyond safe integer range)", "Reject: precision loss");
      }
      push("1.5", "precision (fractional)", "Reject if the contract is integer-only");
      push("NaN", "type violation", "Reject");
      push("Infinity", "type violation", "Reject");
      push('"42"', "type violation (numeric string)", "Reject or coerce — behaviour must be explicit");
      break;
    }

    case "string": {
      const min = c.minLength ?? c.min;
      const max = c.maxLength ?? c.max;
      push('""', "lower boundary (empty string)", c.required ? "Reject: required field" : "Accept as empty");
      push('"a"', "lower boundary (single character)", "Accept");
      if (typeof min === "number" && min > 1) {
        push(`<string of length ${min - 1}>`, "lower boundary (minLength - 1)", "Reject: below minimum length");
        push(`<string of length ${min}>`, "lower boundary (minLength)", "Accept");
      }
      if (typeof max === "number") {
        push(`<string of length ${max - 1}>`, "upper boundary (maxLength - 1)", "Accept");
        push(`<string of length ${max}>`, "upper boundary (maxLength)", "Accept: limit is inclusive");
        push(`<string of length ${max + 1}>`, "upper boundary (maxLength + 1)", "Reject: exceeds maximum length");
      } else {
        push("<string of length 255>", "upper boundary (common column limit)", "Accept or reject explicitly");
        push("<string of length 65536>", "upper boundary (buffer stress)", "Reject gracefully — no truncation, no crash");
      }
      push('"   "', "whitespace only", "Reject if trimmed content is required");
      push('" value "', "leading/trailing whitespace", "Define trim policy explicitly");
      push('"日本語 🚀 Ωmega"', "unicode / multibyte", "Accept: no mojibake, correct length accounting");
      push(`"' OR 1=1 --"`, "injection payload (SQL)", "Treat as literal data — parameterised query");
      push('"<script>alert(1)</script>"', "injection payload (XSS)", "Escape on output — stored safely");
      for (const [input, classification, expected] of formatVectors(name)) {
        push(input, classification, expected);
      }
      break;
    }

    case "boolean": {
      push("true", "valid partition", "Accept");
      push("false", "valid partition", "Accept — must not be treated as missing");
      push('"true"', "type violation (string)", "Reject or coerce explicitly");
      push('"false"', "type violation (truthy string)", "Reject: a non-empty string is truthy");
      push("0", "type violation (falsy number)", "Reject");
      push("1", "type violation (truthy number)", "Reject");
      push('""', "type violation (falsy string)", "Reject");
      break;
    }

    case "enum": {
      for (const member of c.enum) {
        push(JSON.stringify(member), "valid partition (member)", "Accept");
      }
      const first = c.enum[0] ?? "value";
      push(JSON.stringify(String(first).toUpperCase()), "case variation", "Reject or normalise explicitly");
      push('"__unknown__"', "invalid partition (non-member)", "Reject");
      push('""', "invalid partition (empty)", "Reject");
      push("0", "type violation (ordinal index)", "Reject: members are not positional");
      break;
    }

    case "array": {
      const max = c.maxLength ?? c.max;
      push("[]", "lower boundary (empty collection)", c.required ? "Reject if at least one element is required" : "Accept");
      push("[<1 element>]", "lower boundary (single element)", "Accept");
      if (typeof max === "number") {
        push(`[<${max} elements>]`, "upper boundary (max)", "Accept: limit is inclusive");
        push(`[<${max + 1} elements>]`, "upper boundary (max + 1)", "Reject: exceeds maximum");
      } else {
        push("[<1000 elements>]", "upper boundary (volume)", "Accept or paginate — must not time out");
      }
      push("[null]", "element null-state", "Reject: element contract violated");
      push("[<duplicate elements>]", "duplicate members", "Define uniqueness policy explicitly");
      push('"not-an-array"', "type violation", "Reject");
      push("{}", "type violation (object)", "Reject");
      break;
    }

    case "date": {
      push('"2024-01-15T00:00:00Z"', "valid partition (ISO 8601)", "Accept");
      push('"1970-01-01T00:00:00Z"', "lower boundary (epoch)", "Accept or reject explicitly");
      push('"2024-02-29"', "boundary (leap day, valid)", "Accept");
      push('"2023-02-29"', "boundary (leap day, invalid year)", "Reject");
      push('"2024-03-31T01:30:00"', "boundary (DST transition)", "Resolve unambiguously");
      push('"9999-12-31T23:59:59Z"', "upper boundary (max date)", "Accept or reject explicitly");
      push('"2024-13-01"', "invalid partition (month out of range)", "Reject");
      push('"15/01/2024"', "format ambiguity (DD/MM vs MM/DD)", "Reject or require ISO 8601");
      push('"not-a-date"', "type violation", "Reject");
      break;
    }

    case "object": {
      push("<fully populated object>", "valid partition", "Accept");
      push("{}", "lower boundary (empty object)", c.required ? "Reject: required keys absent" : "Accept");
      push("<object missing a required key>", "invalid partition (incomplete)", "Reject with a field-level error");
      push("<object with an unexpected extra key>", "invalid partition (excess)", "Ignore or reject — must be explicit");
      push("<deeply nested object, depth 50>", "upper boundary (nesting depth)", "Reject gracefully — no stack overflow");
      push('"not-an-object"', "type violation", "Reject");
      break;
    }

    default: {
      push("<typical valid value>", "valid partition (nominal)", "Accept");
      push("<empty value>", "lower boundary", "Define behaviour explicitly");
      push("<maximum supported value>", "upper boundary", "Accept at the limit, reject beyond it");
      push("<value of an unexpected type>", "type violation", "Reject");
      break;
    }
  }

  push("null", "null state", nullExpect);
  push("undefined", "null state (omitted)", undefExpect);
  return vectors;
}

function buildEpBuckets(param) {
  const { type, constraints: c, name } = param;
  const valid = [];
  const invalid = [];

  switch (type) {
    case "number":
      valid.push(
        typeof c.min === "number" && typeof c.max === "number"
          ? `Numbers within [${c.min}, ${c.max}]`
          : "Finite numbers inside the documented operating range"
      );
      if (typeof c.min === "number") invalid.push(`Numbers below ${c.min}`);
      else invalid.push("Negative numbers (unless explicitly supported)");
      if (typeof c.max === "number") invalid.push(`Numbers above ${c.max}`);
      else invalid.push("Numbers beyond MAX_SAFE_INTEGER");
      invalid.push("NaN and Infinity", "Non-numeric types (string, boolean, object, array)");
      break;

    case "string": {
      const max = c.maxLength ?? c.max;
      valid.push(max ? `Non-empty strings of length 1..${max}` : "Non-empty strings within the documented length limit");
      if (/email|url|phone/i.test(name)) valid.push(`Strings matching the documented ${name} format`);
      invalid.push(
        "Empty and whitespace-only strings",
        max ? `Strings longer than ${max} characters` : "Strings exceeding the storage column width",
        "Non-string types",
        "Strings carrying injection payloads (SQL / XSS / path traversal)"
      );
      break;
    }

    case "boolean":
      valid.push("Strict boolean true", "Strict boolean false");
      invalid.push("Truthy/falsy non-booleans (0, 1, \"true\", \"\")", "null / undefined when required");
      break;

    case "enum":
      valid.push(`Declared members: ${c.enum.join(", ")}`);
      invalid.push("Values outside the declared member set", "Case variants of valid members", "Ordinal indices in place of members");
      break;

    case "array": {
      const max = c.maxLength ?? c.max;
      valid.push(max ? `Arrays holding 1..${max} well-formed elements` : "Arrays holding well-formed elements within the documented size limit");
      invalid.push(
        c.required ? "Empty arrays" : "Arrays containing null or malformed elements",
        max ? `Arrays longer than ${max}` : "Arrays large enough to breach the response time budget",
        "Non-array types"
      );
      break;
    }

    case "date":
      valid.push("Valid ISO 8601 timestamps inside the supported calendar range");
      invalid.push("Calendar-impossible dates (2023-02-29, month 13)", "Ambiguous or non-ISO formats", "Non-date types");
      break;

    case "object":
      valid.push("Objects satisfying every required key with correctly typed values");
      invalid.push("Objects missing required keys", "Objects with wrongly typed values", "Non-object types");
      break;

    default:
      valid.push("Values satisfying the documented contract");
      invalid.push("Values violating the documented contract", "Unexpected types");
      break;
  }

  if (c.optional) valid.push("null / omitted (documented as optional)");
  else invalid.push("null / undefined (not documented as nullable)");

  return { valid, invalid };
}

function describeConstraints(c) {
  const parts = [];
  if (typeof c.min === "number") parts.push(`min=${c.min}`);
  if (typeof c.max === "number") parts.push(`max=${c.max}`);
  if (typeof c.minLength === "number") parts.push(`minLength=${c.minLength}`);
  if (typeof c.maxLength === "number") parts.push(`maxLength=${c.maxLength}`);
  if (c.enum) parts.push(`enum=[${c.enum.join("|")}]`);
  if (c.required) parts.push("required");
  if (c.optional) parts.push("optional");
  return parts.length ? parts.join(", ") : "none declared";
}

function padCell(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length))
  );
  const line = (cells) => "| " + cells.map((c, i) => padCell(c, widths[i])).join(" | ") + " |";
  const divider = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
  return [line(headers), divider, ...rows.map((r) => line(r))].join("\n");
}

/* ── Test case specification (Senior-QA-Engineer.md section 5) ──────────── */

const VERB_PREFIXES =
  /^(create|get|set|update|delete|remove|add|fetch|load|save|validate|handle|process|build|make|run|execute|apply|calculate|compute|check|verify|ensure|is|has|on)/i;

/** Derives a Component/Module label and the TC_<CODE>_NNN id prefix. */
function deriveModuleInfo(parameters) {
  const fnOrigin = parameters
    .map((p) => p.origin)
    .find((o) => /^(function|arrow|method|def) /.test(o));

  const raw = fnOrigin
    ? fnOrigin.replace(/^(function|arrow|method|def)\s+/, "").replace(/\(\)$/, "")
    : null;

  const noun = raw ? raw.replace(VERB_PREFIXES, "") || raw : "Component";
  const label = titleCase(noun) || "Component";
  const code = (noun.replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "COMP").slice(0, 8);
  return { label, code, invocation: raw };
}

function buildTestCaseTitle(param, vector) {
  const expected = vector.expected.toLowerCase();
  if (expected.startsWith("reject")) return `Verify ${param.name} is rejected at ${vector.classification}`;
  if (expected.startsWith("accept")) return `Verify ${param.name} is accepted at ${vector.classification}`;
  if (expected.startsWith("apply")) return `Verify the documented default applies when ${param.name} is ${vector.classification}`;
  if (expected.startsWith("treat") || expected.startsWith("escape"))
    return `Verify ${param.name} is neutralised at ${vector.classification}`;
  if (expected.startsWith("define") || expected.startsWith("specify") || expected.startsWith("resolve"))
    return `Verify the documented behaviour of ${param.name} at ${vector.classification}`;
  return `Verify ${param.name} behaviour at ${vector.classification}`;
}

/** Renders one test case carrying all nine standard attributes. */
function renderTestCase(tc) {
  return [
    `${tc.id}  |  ${tc.module}  |  ${tc.title}`,
    `  Technique       : ${tc.technique}`,
    `  Pre-conditions  : ${tc.preConditions}`,
    `  Test Steps      : ${tc.steps}`,
    `  Test Data       : ${tc.testData}`,
    `  Expected Result : ${tc.expected}`,
    `  Actual Result   : ${tc.actual}   |   Status: ${tc.status}`,
  ].join("\n");
}

function buildTestCases(parameters, moduleInfo) {
  const cases = [];
  let counter = 1;

  for (const param of parameters) {
    const others = parameters.filter((p) => p.name !== param.name).map((p) => p.name);
    const otherLabel =
      others.length === 0
        ? "no other parameters are required"
        : `all other parameters (${others.slice(0, 5).join(", ")}${others.length > 5 ? ", …" : ""}) hold nominal valid values`;

    const invocation = moduleInfo.invocation ? `${moduleInfo.invocation}()` : moduleInfo.label;

    for (const vector of buildBvaVectors(param)) {
      cases.push({
        id: `TC_${moduleInfo.code}_${String(counter++).padStart(3, "0")}`,
        module: moduleInfo.label,
        title: buildTestCaseTitle(param, vector),
        technique: `Boundary Value Analysis — ${vector.classification}`,
        preConditions: `System under test is reachable and in a known-good state; ${invocation} is invocable; ${otherLabel}`,
        steps: `1. Set ${param.name} = ${vector.input}  2. Hold every other parameter at a nominal valid value  3. Invoke ${invocation}  4. Observe the returned value, rendered state, or raised error`,
        testData: `${param.name} = ${vector.input}`,
        expected: vector.expected,
        actual: "(pending execution)",
        status: "Not Run",
        parameter: param.name,
      });
    }
  }

  return cases;
}

/* ── Decision Table testing (Senior-QA-Engineer.md section 5) ───────────── */

const MAX_DECISION_RULES = 32;

function buildDecisionTable(parameters) {
  const finite = parameters.filter(
    (p) => p.type === "boolean" || (p.type === "enum" && Array.isArray(p.constraints.enum))
  );
  if (finite.length < 2) return null;

  const used = finite.slice(0, 3);
  const domains = used.map((p) =>
    p.type === "boolean" ? ["true", "false"] : p.constraints.enum.slice(0, 4)
  );

  let rules = [[]];
  for (const domain of domains) {
    const next = [];
    for (const rule of rules) for (const value of domain) next.push([...rule, value]);
    rules = next;
  }

  const total = rules.length;
  const shown = rules.slice(0, MAX_DECISION_RULES);

  const headers = ["Rule", ...used.map((p) => p.name), "Expected Action"];
  const rows = shown.map((rule, i) => [
    `R${String(i + 1).padStart(2, "0")}`,
    ...rule,
    i === 0
      ? "Baseline / happy path — confirm the primary success outcome"
      : "Derive from requirements; confirm it differs from the baseline where business rules dictate",
  ]);

  return {
    dimensions: used.map((p, i) => `${p.name}(${domains[i].length})`).join(" x "),
    total,
    shown: shown.length,
    truncated: total > MAX_DECISION_RULES,
    table: renderTable(headers, rows),
    skipped: finite.length > 3 ? finite.slice(3).map((p) => p.name) : [],
  };
}

/* ── State Transition testing (Senior-QA-Engineer.md section 5) ─────────── */

const STATE_VOCAB = [
  "draft", "pending", "active", "inactive", "enabled", "disabled", "locked",
  "unlocked", "approved", "rejected", "published", "archived", "open", "closed",
  "expired", "cancelled", "canceled", "completed", "failed", "suspended",
  "blocked", "verified", "unverified", "paid", "unpaid", "shipped", "delivered",
  "returned", "processing", "queued", "running", "trialing", "past_due",
];

function detectStates(source, parameters) {
  const found = new Set();

  for (const word of STATE_VOCAB) {
    if (new RegExp(`\\b${word}\\b`, "i").test(source)) found.add(word.toLowerCase());
  }
  for (const param of parameters) {
    if (!/state|status|phase|stage/i.test(param.name)) continue;
    for (const member of param.constraints.enum ?? []) found.add(String(member).toLowerCase());
  }
  return [...found].slice(0, 8);
}

/** Canonical event verb that drives a system into each known state. */
const STATE_EVENT_VERBS = {
  draft: "saveDraft", pending: "submit", active: "activate", inactive: "deactivate",
  enabled: "enable", disabled: "disable", locked: "lock", unlocked: "unlock",
  approved: "approve", rejected: "reject", published: "publish", archived: "archive",
  open: "open", closed: "close", expired: "expire", cancelled: "cancel",
  canceled: "cancel", completed: "complete", failed: "fail", suspended: "suspend",
  blocked: "block", verified: "verify", unverified: "revokeVerification",
  paid: "pay", unpaid: "voidPayment", shipped: "ship", delivered: "deliver",
  returned: "return", processing: "process", queued: "enqueue", running: "start",
  trialing: "startTrial", past_due: "missPayment",
};

function detectEvents(parameters, states = []) {
  const events = new Set();
  for (const param of parameters) {
    const match = param.origin.match(/^(?:function|arrow|method|def)\s+(\w+)/);
    if (match) events.add(match[1]);
  }
  for (const state of states) {
    const verb = STATE_EVENT_VERBS[state];
    if (verb) events.add(verb);
  }
  if (events.size === 0) ["submit", "approve", "cancel", "retry"].forEach((e) => events.add(e));
  return [...events].slice(0, 6);
}

/**
 * Finds a bounded failure counter such as failed-login attempts.
 * Deliberately excludes generic "count" names: seatCount is a quantity, not a
 * lockout counter, and treating it as one produces a nonsensical state model.
 */
const LOCKOUT_COUNTER = /attempt|retry|retries|failure|failed|tries|strike|lockout/i;

function findThresholdCounter(parameters) {
  return parameters.find(
    (p) =>
      p.type === "number" &&
      LOCKOUT_COUNTER.test(p.name) &&
      typeof p.constraints.max === "number"
  );
}

function buildStateTransition(source, parameters, moduleInfo) {
  const states = detectStates(source, parameters);
  const counter = findThresholdCounter(parameters);
  if (states.length < 2 && !counter) return null;

  const sections = [];

  if (states.length >= 2) {
    const events = detectEvents(parameters, states);
    sections.push(
      `Detected states : ${states.join(", ")}`,
      `Detected events : ${events.join(", ")}`,
      "",
      "Transition matrix — fill each cell with the resulting state, or ILLEGAL if the",
      "transition must be refused. Every ILLEGAL cell becomes a negative test case.",
      "",
      renderTable(
        ["Current State", ...events],
        states.map((s) => [s, ...events.map(() => "?")])
      ),
      "",
      "Mandatory negative coverage:",
      ...states.map(
        (s) =>
          `  - From "${s}", attempt every event marked ILLEGAL and assert the state is unchanged and an error is surfaced.`
      )
    );
  }

  if (counter) {
    const max = counter.constraints.max;
    if (sections.length) sections.push("");
    sections.push(
      `Threshold transition — ${counter.name} (max ${max}):`,
      ...[
        [max - 1, "remain in the permissive state; the action still succeeds."],
        [max, "transition to the restricted state on this attempt."],
        [max + 1, "remain restricted; confirm no double penalty is applied."],
      ].map(([value, outcome]) => {
        const width = String(max + 1).length;
        return `  - ${counter.name} = ${padCell(String(value), width)} : ${outcome}`;
      }),
      `  - After a successful action, confirm ${counter.name} resets to its initial value.`,
      "  - Confirm the restricted state survives a session restart (it must not be client-side only)."
    );
  }

  return sections.join("\n");
}

/* ── Exploratory test charters (Manual-Testing.md sections 1-2) ─────────── */

function buildExploratoryCharters(parameters, moduleInfo) {
  const target = moduleInfo.label;
  const charters = [
    {
      charter: `Explore ${target} input handling with boundary and malformed data to discover unhandled crashes and unclear error messages`,
      timebox: "45 min",
      heuristics: "Goldilocks (too big / too small / just right); CRUD; error-message clarity",
      capture: "Stack traces, raw error text shown to the user, HTTP status codes",
    },
    {
      charter: `Explore ${target} under rapid repeated submission to discover duplicate records and race conditions`,
      timebox: "30 min",
      heuristics: "Double-click the submit control; resubmit before the response lands; two tabs at once",
      capture: "Duplicate rows, conflicting totals, network waterfall",
    },
    {
      charter: `Explore ${target} with oversized and pasted content to discover layout breakage and silent truncation`,
      timebox: "30 min",
      heuristics: "Paste a multi-paragraph block; paste emoji and RTL text; paste formatted HTML",
      capture: "Screenshots of clipped layout, stored vs displayed value, console warnings",
    },
    {
      charter: `Explore ${target} under interruption to discover inconsistent persisted state`,
      timebox: "45 min",
      heuristics: "Kill the network mid-request; browser back during submit; refresh mid-flow; session expiry",
      capture: "Database state vs UI state, retry behaviour, data loss",
    },
    {
      charter: `Explore ${target} across locale, timezone, and currency changes to discover formatting and calculation defects`,
      timebox: "30 min",
      heuristics: "Switch language mid-flow; set a UTC-offset timezone; use a comma-decimal locale",
      capture: "Misformatted dates and amounts, untranslated strings, off-by-one day errors",
    },
    {
      charter: `Explore ${target} with varied roles and permissions to discover authorisation bypasses`,
      timebox: "45 min",
      heuristics: "Lower-privilege account; direct URL access; tampered identifiers in the request",
      capture: "Responses that should be 403, leaked fields, visible controls that should be hidden",
    },
  ];

  const formatted = parameters.filter((p) => /email|url|phone|password|card|postcode|zip/i.test(p.name));
  if (formatted.length) {
    charters.push({
      charter: `Explore ${target} format validation for ${formatted.map((p) => p.name).join(", ")} to discover over-strict and under-strict rules`,
      timebox: "30 min",
      heuristics: "Valid-but-unusual real values; internationally valid formats; leading/trailing whitespace",
      capture: "Legitimate values wrongly rejected, invalid values wrongly accepted",
    });
  }

  return charters;
}

function renderCharter(entry, index) {
  return [
    `EXP-${String(index + 1).padStart(2, "0")}  (timebox: ${entry.timebox})`,
    `  Charter    : ${entry.charter}`,
    `  Heuristics : ${entry.heuristics}`,
    `  Capture    : ${entry.capture}`,
  ].join("\n");
}

function handleGenerateQaMatrix(args) {
  const { codeSnippet } = validateArgs(args, {
    codeSnippet: { required: true, preserveWhitespace: true },
  });

  const { source, inputKind } = normalizeSource(codeSnippet);
  const discovered = extractParameters(source);

  const parameters = discovered.map((p) => {
    const context = gatherContext(source, p.name);
    const constraints = extractConstraints(context, p.rawType);
    const type = inferType(p.name, p.rawType, constraints);
    return { ...p, constraints, type };
  });

  const sections = [
    "=== SENIOR QA TEST STRATEGY ===",
    `[Input Kind]     ${inputKind}`,
    `[Input Size]     ${codeSnippet.length} characters`,
    `[Parameters]     ${parameters.length} detected`,
  ];

  if (parameters.length === 0) {
    sections.push(
      "",
      "--- ANALYSIS NOTE ---",
      "No named parameters, typed fields, or requirement bullets could be extracted from this input.",
      "Supply one of the following for a parametric matrix:",
      "  - a function or method signature (JS/TS/Python)",
      "  - a TypeScript interface or type declaration",
      "  - a git diff containing the above",
      "  - markdown requirement bullets in the form: - fieldName (type, constraints)",
      "",
      "--- GENERIC RISK CHECKLIST (fallback) ---",
      "1. Null / undefined handling on every input path.",
      "2. Empty-collection and single-element boundaries.",
      "3. Minimum and maximum limits, plus the value immediately outside each.",
      "4. Type-violation inputs for every parameter.",
      "5. Concurrency: the same operation issued twice simultaneously.",
      "6. Authorisation: the operation attempted by an unentitled caller."
    );
    return toolText(sections.join("\n"));
  }

  const moduleInfo = deriveModuleInfo(parameters);
  sections.push(`[Module]         ${moduleInfo.label}`);

  sections.push(
    "",
    "--- PARAMETER INVENTORY ---",
    renderTable(
      ["#", "Parameter", "Inferred Type", "Constraints", "Detected In"],
      parameters.map((p, i) => [
        String(i + 1),
        p.name,
        p.type,
        describeConstraints(p.constraints),
        p.origin,
      ])
    )
  );

  // Nine-attribute test case specification derived from BVA.
  const testCases = buildTestCases(parameters, moduleInfo);
  sections.push(
    "",
    "--- BOUNDARY VALUE ANALYSIS — TEST CASE SPECIFICATION ---",
    "Each case is atomic, independent, and repeatable. Actual Result and Status are",
    "completed during execution.",
    "",
    testCases.map(renderTestCase).join("\n\n")
  );

  sections.push("", "--- EQUIVALENCE PARTITIONING BUCKETS ---");
  for (const param of parameters) {
    const { valid, invalid } = buildEpBuckets(param);
    sections.push(
      "",
      `${param.name} (${param.type})`,
      ...valid.map((v) => `  [VALID]   ${v}`),
      ...invalid.map((v) => `  [INVALID] ${v}`)
    );
  }

  const decision = buildDecisionTable(parameters);
  if (decision) {
    sections.push(
      "",
      "--- DECISION TABLE ---",
      `Dimensions : ${decision.dimensions}  ->  ${decision.total} rules`,
      "Decision tables encode business rules. The combinations below are exhaustive for",
      "the selected conditions; fill the action column from the requirement source, then",
      "promote each row into its own test case.",
      "",
      decision.table
    );
    if (decision.truncated) {
      sections.push(
        "",
        `NOTE: ${decision.total - decision.shown} further rules exist and are not listed (cap ${MAX_DECISION_RULES}).`
      );
    }
    if (decision.skipped.length) {
      sections.push(
        `NOTE: conditions not included as dimensions: ${decision.skipped.join(", ")}.`
      );
    }
  }

  const stateTransition = buildStateTransition(source, parameters, moduleInfo);
  if (stateTransition) {
    sections.push("", "--- STATE TRANSITION TESTING ---", stateTransition);
  }

  const charters = buildExploratoryCharters(parameters, moduleInfo);
  sections.push(
    "",
    "--- EXPLORATORY TEST CHARTERS (HUMAN TESTER) ---",
    "Session-based charters for a human tester. These complement the scripted cases",
    "above; they are deliberately not automatable.",
    "",
    charters.map(renderCharter).join("\n\n"),
    "",
    "Run each session with the Thinking Aloud protocol where a second observer is",
    "available, and log every finding with evidence as described in the bug report",
    "template emitted by parse_error_logs."
  );

  const byType = parameters.reduce((acc, p) => {
    acc[p.type] = (acc[p.type] ?? 0) + 1;
    return acc;
  }, {});
  const unresolved = parameters.filter((p) => p.type === "unknown").map((p) => p.name);

  sections.push(
    "",
    "--- COVERAGE SUMMARY ---",
    `Parameters analysed   : ${parameters.length}`,
    `Scripted test cases   : ${testCases.length}`,
    `Decision table rules  : ${decision ? decision.total : 0}`,
    `State transition model: ${stateTransition ? "generated" : "not applicable"}`,
    `Exploratory charters  : ${charters.length}`,
    `Type distribution     : ${Object.entries(byType).map(([t, n]) => `${t}=${n}`).join(", ")}`,
    unresolved.length
      ? `Unresolved types      : ${unresolved.join(", ")} — annotate these to sharpen the matrix.`
      : "Unresolved types      : none"
  );

  return toolText(sections.join("\n"));
}

/* ──────────────────────────────────────────────────────────────────────────
 * Tool 5: generate_ui_ux_checklist
 *
 * Acts as a Lead UI/UX Auditor: responsive breakpoints, cross-browser engine
 * matrix, interactive component states, visual regression targets, WCAG
 * checkpoints, and risk-ranked user flows for manual verification.
 * ────────────────────────────────────────────────────────────────────────── */

const VIEWPORTS = [
  { label: "Mobile Portrait (small)", width: 375, height: 667, notes: "iPhone SE / 8 class. Tightest text wrapping budget." },
  { label: "Mobile Portrait (large)", width: 414, height: 896, notes: "iPhone Plus / Max class. Verify safe-area insets." },
  { label: "Tablet Portrait", width: 768, height: 1024, notes: "Common breakpoint boundary — test 767 and 769 either side." },
  { label: "Desktop Base", width: 1280, height: 800, notes: "Most common laptop viewport." },
  { label: "Desktop Wide", width: 1440, height: 900, notes: "Verify max-width containers do not over-stretch." },
  { label: "Desktop Full HD", width: 1920, height: 1080, notes: "Check for excessive whitespace and centred-layout drift." },
];

const BROWSER_ENGINES = [
  { engine: "Blink", browsers: "Chrome, Edge, Opera", risks: "Baseline. Flexbox/grid reference rendering; most permissive." },
  { engine: "WebKit", browsers: "Safari (macOS, iOS)", risks: "Date inputs, backdrop-filter, scroll momentum, 100vh with dynamic toolbars, gap in flexbox on older versions." },
  { engine: "Gecko", browsers: "Firefox", risks: "Scrollbar styling, form control sizing, font smoothing differences." },
];

const UI_STATES = [
  { state: "Default", verify: "Baseline rendering matches the design specification." },
  { state: "Hover", verify: "Affordance changes; must not shift layout. Confirm it is not the only cue (touch devices have no hover)." },
  { state: "Focus", verify: "Visible focus ring meeting 3:1 contrast against adjacent colours; reachable by keyboard Tab in a logical order." },
  { state: "Active / Pressed", verify: "Immediate visual acknowledgement on press before the response returns." },
  { state: "Disabled", verify: "Visually distinct, non-interactive, and announced as disabled to assistive technology." },
  { state: "Loading", verify: "Spinner or skeleton appears within 100ms; control is locked against double submission." },
  { state: "Empty", verify: "Zero-data state explains what is missing and offers the next action." },
  { state: "Error", verify: "Message is specific, adjacent to the offending field, and announced via a live region." },
  { state: "Success", verify: "Confirmation persists long enough to be read and does not rely on colour alone." },
];

const WCAG_CHECKS = [
  { criterion: "1.1.1 Non-text Content", level: "A", check: "Every image, icon button, and chart has a meaningful alt or aria-label; decorative images are alt=\"\"." },
  { criterion: "1.3.1 Info and Relationships", level: "A", check: "Headings are real heading elements in order; form inputs have associated labels; tables use th scope." },
  { criterion: "1.4.3 Contrast (Minimum)", level: "AA", check: "Body text ≥ 4.5:1, large text ≥ 3:1 against its background." },
  { criterion: "1.4.11 Non-text Contrast", level: "AA", check: "Interactive boundaries, focus indicators, and icons ≥ 3:1." },
  { criterion: "1.4.4 Resize Text", level: "AA", check: "Zoom to 200% without loss of content or horizontal scrolling." },
  { criterion: "2.1.1 Keyboard", level: "A", check: "Every control is operable by keyboard alone; no keyboard trap." },
  { criterion: "2.4.3 Focus Order", level: "A", check: "Tab order follows the visual reading order; modals trap and restore focus correctly." },
  { criterion: "2.4.7 Focus Visible", level: "AA", check: "Focus indicator is never suppressed without an equivalent replacement." },
  { criterion: "3.3.1 Error Identification", level: "A", check: "Errors are described in text, not signalled by colour or position alone." },
  { criterion: "4.1.2 Name, Role, Value", level: "A", check: "Custom widgets expose correct role, state, and value to assistive technology." },
];

const UX_METRICS = [
  { metric: "Task Success Rate", target: "≥ 90% unaided completion", method: "Run the flow with 5+ representative users; record completion without help." },
  { metric: "Time on Task", target: "Within the agreed budget for the flow", method: "Time from first interaction to confirmation. Investigate anything over 3 minutes for a checkout-class flow." },
  { metric: "Error Rate", target: "< 1 misstep per task", method: "Count wrong-control clicks, invalid submissions, and backtracks per participant." },
  { metric: "Rage Clicks", target: "Zero", method: "Session replay (Hotjar / Clarity). Repeated clicks on one element indicate an unresponsive or falsely-interactive affordance." },
  { metric: "Scroll Depth", target: "Primary action seen by ≥ 95%", method: "Heatmap. Confirm the primary call to action is discovered without hunting." },
];

/** Splits a requirements page or flow description into candidate user flows. */
/** "email (string, required)" declares a field; it is not a user journey. */
const FIELD_DEFINITION = /^[A-Za-z_]\w*\s*[:(]\s*(string|number|boolean|int|integer|float|date|array|object|enum)\b/i;

function extractUserFlows(description) {
  const lines = description
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 8)
    .filter((l) => !FIELD_DEFINITION.test(l))
    .filter((l) => !/^#{1,6}\s/.test(l));

  const flows = lines.length > 0 ? lines : splitFlowSteps(description);
  return flows.slice(0, 12);
}

/**
 * Risk weighting. A write that moves money outranks a read of the same data,
 * so mutation is scored separately from subject matter. "email" is deliberately
 * absent from the messaging signal: it appears as a credential far more often
 * than as an outbound notification.
 */
const RISK_SIGNALS = [
  { re: /pay|checkout|billing|card|invoice|refund|subscription|price|charge/i, weight: 5, reason: "handles money" },
  { re: /login|signup|sign up|auth|password|session|token|mfa|2fa|credential/i, weight: 5, reason: "controls account access" },
  { re: /delete|remove|destroy|cancel|terminate|close account/i, weight: 4, reason: "irreversible action" },
  { re: /permission|role|admin|grant|revoke|share|invite/i, weight: 4, reason: "authorisation boundary" },
  { re: /\b(add|adds|create|creates|update|updates|edit|edits|save|saves|submit|submits|pay|pays|purchase|invite|invites|upgrade|downgrade)\b/i, weight: 3, reason: "writes state" },
  { re: /upload|import|attachment/i, weight: 3, reason: "ingests external files" },
  { re: /address|personal|profile|gdpr|consent|privacy|pii/i, weight: 3, reason: "personal data" },
  { re: /download|export|print/i, weight: 2, reason: "data egress" },
  { re: /search|filter|sort|paginat/i, weight: 2, reason: "data-heavy interaction" },
  { re: /notif|sms|alert|reminder/i, weight: 2, reason: "outbound messaging" },
];

function scoreFlowRisk(flow) {
  const reasons = [];
  let score = 1;
  for (const signal of RISK_SIGNALS) {
    if (signal.re.test(flow)) {
      score += signal.weight;
      reasons.push(signal.reason);
    }
  }
  return { flow, score, reasons: reasons.length ? reasons : ["standard interaction"] };
}

function handleGenerateUiUxChecklist(args) {
  const { requirements, scope } = validateArgs(args, {
    requirements: { required: true, preserveWhitespace: true },
    scope: { required: false, enum: ["full", "responsive", "accessibility", "ux"], default: "full", maxLength: 32 },
  });

  const flows = extractUserFlows(requirements);
  const ranked = flows.map(scoreFlowRisk).sort((a, b) => b.score - a.score);
  const topRisk = ranked.slice(0, 3);

  const sections = [
    "=== UI / UX AUDIT CHECKLIST ===",
    `[Scope]          ${scope}`,
    `[Input Size]     ${requirements.length} characters`,
    `[Flows Detected] ${flows.length}`,
  ];

  const wantsAll = scope === "full";

  if (wantsAll || scope === "responsive") {
    sections.push(
      "",
      "--- RESPONSIVE VIEWPORT MATRIX ---",
      "Resize to each width and confirm no clipped text, distorted grid, horizontal",
      "scrollbar, or overlapping control. Test one pixel either side of each breakpoint.",
      "",
      renderTable(
        ["Viewport", "Width", "Height", "Watch For"],
        VIEWPORTS.map((v) => [v.label, `${v.width}px`, `${v.height}px`, v.notes])
      ),
      "",
      "Per-viewport checks:",
      "  [ ] No horizontal page scroll at any width.",
      "  [ ] Tap targets ≥ 44x44px on touch viewports.",
      "  [ ] Text reflows rather than truncating; no mid-word clipping.",
      "  [ ] Images and media scale with max-width:100% and keep aspect ratio.",
      "  [ ] Sticky headers and footers do not occlude content or the primary action.",
      "  [ ] Modals and dropdowns remain fully on-screen and scrollable.",
      "  [ ] Landscape orientation on mobile does not break the layout."
    );

    sections.push(
      "",
      "--- CROSS-BROWSER RENDERING MATRIX ---",
      renderTable(
        ["Engine", "Browsers", "Known Risk Areas"],
        BROWSER_ENGINES.map((b) => [b.engine, b.browsers, b.risks])
      )
    );
  }

  if (wantsAll || scope === "responsive") {
    sections.push(
      "",
      "--- VISUAL REGRESSION TARGETS ---",
      "Capture a baseline per target per viewport. Flag any pixel delta for review.",
      "",
      ...topRisk.map((r, i) => `  VRT-${String(i + 1).padStart(2, "0")}  ${r.flow}`),
      "",
      "  [ ] Baselines captured on a pinned browser version (versions change rendering).",
      "  [ ] Dynamic regions (timestamps, avatars, carousels) masked before comparison.",
      "  [ ] Animations disabled or settled before capture to avoid false positives.",
      "  [ ] Components also captured in isolation (Storybook) to localise failures.",
      "  [ ] Both light and dark themes captured where supported."
    );
  }

  if (wantsAll || scope !== "responsive") {
    sections.push(
      "",
      "--- INTERACTIVE COMPONENT STATES ---",
      "Verify every interactive element in each state below.",
      "",
      renderTable(["State", "Verification"], UI_STATES.map((s) => [s.state, s.verify]))
    );
  }

  if (wantsAll || scope === "accessibility") {
    sections.push(
      "",
      "--- ACCESSIBILITY (WCAG 2.1 AA) ---",
      renderTable(
        ["Criterion", "Level", "Check"],
        WCAG_CHECKS.map((c) => [c.criterion, c.level, c.check])
      ),
      "",
      "Automated scanning covers roughly a third of these. Run axe-core in the E2E suite",
      "(see generate_automation_script), then verify the remainder manually with a",
      "keyboard and a screen reader."
    );
  }

  if (wantsAll || scope === "ux") {
    sections.push(
      "",
      "--- UX USABILITY METRICS ---",
      renderTable(
        ["Metric", "Target", "Method"],
        UX_METRICS.map((m) => [m.metric, m.target, m.method])
      ),
      "",
      "--- OBSERVATION PROTOCOL ---",
      "  [ ] Thinking Aloud: ask the participant to narrate expectations and confusion.",
      "  [ ] Do not assist until the participant is genuinely stuck; record where that happens.",
      "  [ ] Capture session replays and heatmaps to corroborate self-reported friction.",
      "  [ ] Note emotional friction (sighs, hesitation, backtracking) — automation cannot see it."
    );
  }

  sections.push(
    "",
    "--- HIGHEST-RISK FLOWS FOR MANUAL VERIFICATION ---",
    "Ranked by blast radius. Verify these by hand every release, regardless of",
    "automated coverage."
  );

  if (topRisk.length === 0) {
    sections.push(
      "",
      "No discrete user flows could be extracted. Supply a requirements page, a list of",
      "user journeys, or numbered flow steps to obtain a ranked list."
    );
  } else {
    topRisk.forEach((entry, i) => {
      sections.push(
        "",
        `RISK-${String(i + 1).padStart(2, "0")}  (score ${entry.score})  ${entry.flow}`,
        `  Why it ranks  : ${entry.reasons.join("; ")}`,
        "  Manual checks : Happy path end to end; interrupt mid-flow (network drop, back button, refresh);",
        "                  resubmit rapidly; confirm the resulting state in the system of record.",
        "  Evidence      : Screen recording, console log, network waterfall, final persisted state."
      );
    });
  }

  sections.push(
    "",
    "--- SUMMARY ---",
    `Viewports to cover      : ${VIEWPORTS.length}`,
    `Rendering engines       : ${BROWSER_ENGINES.length}`,
    `Component states        : ${UI_STATES.length}`,
    `WCAG criteria           : ${WCAG_CHECKS.length}`,
    `UX metrics              : ${UX_METRICS.length}`,
    `Flows ranked            : ${ranked.length}`,
    `Manual-priority flows   : ${topRisk.length}`
  );

  return toolText(sections.join("\n"));
}

/* ──────────────────────────────────────────────────────────────────────────
 * Tool 6: generate_manual_test_plan
 *
 * The human-tester counterpart to generate_qa_matrix. Emits the scripted
 * checklist, negative and boundary loops, contextual edge cases, exploratory
 * charters, a defect report template, and STLC exit criteria.
 * ────────────────────────────────────────────────────────────────────────── */

const CONTEXTUAL_EDGE_CASES = [
  "Double-click the primary submit control rapidly — confirm exactly one record is created.",
  "Submit, then press the browser Back button and resubmit — confirm no duplicate and no stale state.",
  "Refresh the page mid-flow — confirm partially entered data is either preserved or cleanly discarded.",
  "Paste a multi-paragraph block into every short text input — confirm graceful truncation or a clear limit message.",
  "Paste emoji, right-to-left script, and accented characters — confirm storage and redisplay are byte-accurate.",
  "Disconnect the network immediately after submitting — confirm the user is told, and the server state matches the UI.",
  "Change the interface language mid-flow — confirm no untranslated strings and no lost input.",
  "Change the device timezone and repeat a date-sensitive step — confirm no off-by-one-day error.",
  "Open the same record in two tabs and save from both — confirm the lost-update conflict is detected or prevented.",
  "Let the session expire mid-flow, then act — confirm a clean re-authentication without data loss.",
  "Zoom the browser to 200% — confirm no content is lost and no horizontal scrolling appears.",
  "Navigate the entire flow with the keyboard only — confirm every control is reachable and operable.",
];

const ENVIRONMENT_SETUP = [
  "Test account provisioned at the required entitlement level (free / paid / admin).",
  "Seed data created: at least one empty-state record and one fully-populated record.",
  "Edge-state fixtures seeded (expired card, suspended account, maximum-size collection).",
  "Browser and version recorded; cache and cookies cleared before the first run.",
  "Device, OS, and screen resolution recorded.",
  "Network profile selected (fast 3G throttling for at least one pass).",
  "Feature flags confirmed in the intended state for this build.",
  "Build number and environment URL recorded for the test report.",
];

const EXIT_CRITERIA = [
  "All planned scripted cases executed; none left in Not Run.",
  "Zero open Critical or High defects in the feature under test.",
  "Every failed case has a logged defect with full reproduction evidence.",
  "All exploratory charters completed and debriefed.",
  "Regression pass completed on the surrounding module (defect clustering: bugs cluster where bugs were found).",
  "Pass rate and defect density recorded in the Test Summary Report.",
  "Known limitations and deferred defects documented and accepted by the product owner.",
];

function deriveFeatureName(spec) {
  const heading = spec.match(/^\s*#{1,3}\s+(.+)$/m);
  if (heading) return heading[1].trim().slice(0, 80);
  const firstLine = spec.split("\n").map((l) => l.trim()).find((l) => l.length > 3);
  return (firstLine ?? "Feature Under Test").replace(/^[-*+]\s*/, "").slice(0, 80);
}

function buildNegativeChecks(parameters) {
  const checks = [];

  for (const param of parameters) {
    const c = param.constraints;
    switch (param.type) {
      case "string":
        checks.push(`Leave ${param.name} empty and submit — expect a specific, field-adjacent error.`);
        checks.push(`Enter only whitespace in ${param.name} — expect the same rejection as empty.`);
        if (/email|url|phone|postcode|zip|card/i.test(param.name)) {
          checks.push(`Enter a malformed ${param.name} — expect rejection naming the expected format.`);
        }
        break;
      case "number":
        checks.push(`Enter a non-numeric value in ${param.name} — expect rejection, not a silent zero.`);
        checks.push(`Enter a negative value in ${param.name} — expect rejection unless negatives are specified.`);
        break;
      case "enum":
        checks.push(`Force a value outside [${(c.enum ?? []).join(", ")}] for ${param.name} via devtools — expect server-side rejection.`);
        break;
      case "date":
        checks.push(`Enter an impossible date in ${param.name} (e.g. 2023-02-29) — expect rejection.`);
        break;
      case "array":
        checks.push(`Submit ${param.name} empty — expect the documented empty-collection behaviour.`);
        break;
      default:
        checks.push(`Submit ${param.name} with an unexpected type — expect a clear rejection.`);
        break;
    }
  }

  checks.push(
    "Submit the form with every field empty — expect all errors shown at once, not one at a time.",
    "Submit while unauthenticated — expect redirect to sign-in, not a server error.",
    "Submit as a lower-privilege user — expect 403, and confirm the control was not visible in the first place.",
    "Tamper with a record identifier in the request — expect rejection, not another tenant's data."
  );

  return checks;
}

function buildBoundaryChecks(parameters) {
  const checks = [];
  for (const param of parameters) {
    const c = param.constraints;
    const min = c.minLength ?? c.min;
    const max = c.maxLength ?? c.max;

    if (typeof min === "number") {
      checks.push(`${param.name}: enter ${min - 1} — expect rejection; enter ${min} — expect acceptance.`);
    }
    if (typeof max === "number") {
      checks.push(`${param.name}: enter ${max} — expect acceptance; enter ${max + 1} — expect rejection.`);
    }
    if (typeof min !== "number" && typeof max !== "number") {
      if (param.type === "boolean") {
        checks.push(`${param.name}: toggle both states and submit — confirm false is honoured and not treated as absent.`);
      } else if (param.type === "enum") {
        checks.push(`${param.name}: submit each of [${(c.enum ?? []).join(", ")}] — confirm every member is accepted.`);
      } else {
        checks.push(`${param.name}: no documented limit — probe for the real one and confirm the failure is graceful, not a crash.`);
      }
    }
  }
  if (checks.length === 0) {
    checks.push("No bounded fields detected — identify the limits from the specification before this pass.");
  }
  return checks;
}

function renderChecklist(prefix, items, startAt = 1) {
  return items.map((item, i) => `  [ ] ${prefix}-${String(startAt + i).padStart(3, "0")}  ${item}`);
}

function handleGenerateManualTestPlan(args) {
  const { featureSpec, depth } = validateArgs(args, {
    featureSpec: { required: true, preserveWhitespace: true },
    depth: { required: false, enum: ["smoke", "standard", "exhaustive"], default: "standard", maxLength: 32 },
  });

  const { source } = normalizeSource(featureSpec);
  const discovered = extractParameters(source);
  const parameters = discovered.map((p) => {
    const context = gatherContext(source, p.name);
    const constraints = extractConstraints(context, p.rawType);
    return { ...p, constraints, type: inferType(p.name, p.rawType, constraints) };
  });

  const featureName = deriveFeatureName(featureSpec);
  const flows = extractUserFlows(featureSpec);
  const derived = parameters.length ? deriveModuleInfo(parameters) : null;
  const moduleInfo =
    derived && derived.label !== "Component"
      ? derived
      : { label: featureName, code: derived?.code ?? "FEAT", invocation: derived?.invocation ?? null };
  const isSmoke = depth === "smoke";
  const isExhaustive = depth === "exhaustive";

  const sections = [
    "=== MANUAL TEST PLAN ===",
    `[Feature]        ${featureName}`,
    `[Depth]          ${depth}`,
    `[Flows Detected] ${flows.length}`,
    `[Fields]         ${parameters.length}`,
    "",
    "Execute top to bottom. Mark each item [x] on pass, [!] on fail, [-] if blocked.",
    "Every [!] must produce a defect using the template at the end of this plan.",
  ];

  sections.push(
    "",
    "--- PHASE A: ENVIRONMENT & STATE SETUP ---",
    ...renderChecklist("ENV", ENVIRONMENT_SETUP)
  );

  const happyPath = flows.length
    ? flows.map((f) => `${f} — confirm the expected outcome and the resulting persisted state.`)
    : ["No discrete flows detected. Walk the feature end to end as the primary user and record each step."];

  sections.push(
    "",
    "--- PHASE B1: HAPPY PATH VALIDATION ---",
    "The default, perfect scenario must work exactly as advertised before anything else.",
    "",
    ...renderChecklist("HP", happyPath)
  );

  if (!isSmoke) {
    sections.push(
      "",
      "--- PHASE B2: NEGATIVE PATH VALIDATION ---",
      "Deliberately pass invalid, malformed, and unauthorised inputs. The system must",
      "reject them gracefully with a clear, specific message — never a stack trace.",
      "",
      ...renderChecklist("NEG", buildNegativeChecks(parameters))
    );

    sections.push(
      "",
      "--- PHASE B3: BOUNDARY EXPLORATION ---",
      "Enter the exact minimum and maximum thresholds and the values immediately outside.",
      "",
      ...renderChecklist("BND", buildBoundaryChecks(parameters))
    );

    const edgeCases = isExhaustive ? CONTEXTUAL_EDGE_CASES : CONTEXTUAL_EDGE_CASES.slice(0, 7);
    sections.push(
      "",
      "--- PHASE B4: CONTEXTUAL EDGE CASES ---",
      "Unpredictable human behaviour that automation does not emulate.",
      "",
      ...renderChecklist("CTX", edgeCases)
    );
    if (!isExhaustive) {
      sections.push(
        `  NOTE: ${CONTEXTUAL_EDGE_CASES.length - edgeCases.length} further edge cases omitted at depth "${depth}". Use depth "exhaustive" for the full set.`
      );
    }
  } else {
    sections.push(
      "",
      `NOTE: depth "smoke" omits the negative, boundary, and contextual passes. Use "standard" or "exhaustive" for full coverage.`
    );
  }

  if (!isSmoke) {
    const charters = buildExploratoryCharters(parameters, moduleInfo);
    sections.push(
      "",
      "--- EXPLORATORY SESSION CHARTERS ---",
      "Unscripted, timeboxed investigation. Design and adjust tests as you observe.",
      "",
      charters.map(renderCharter).join("\n\n")
    );
  }

  sections.push(
    "",
    "--- PHASE C: DEFECT REPORT TEMPLATE ---",
    "Copy this block for every failure. An immutable report is reproducible by anyone.",
    "",
    "  Summary          : <one punchy sentence: what broke, where>",
    "  Severity         : Critical | High | Medium | Low",
    "  Component/Module : " + moduleInfo.label,
    "  Environment      : Browser + version | OS + version | Device | Screen resolution",
    "                     Build number | Environment URL | Feature flag states",
    "  Pre-conditions   : <exact account state and seeded data required>",
    "  Steps to Repro   : 1. <action>",
    "                     2. <action>",
    "                     3. <action>",
    "  Expected Result  : <what the specification says should happen>",
    "  Actual Result    : <what the system actually did>",
    "  Evidence         : Screenshot | Screen recording | Console log | Network HAR | Server log excerpt",
    "  Reproducibility  : Always | Intermittent (n of 10) | Once",
    "",
    "Raw terminal output or a stack trace can be converted into this structure",
    "automatically by the parse_error_logs tool."
  );

  sections.push(
    "",
    "--- EXIT CRITERIA (TEST CYCLE CLOSURE) ---",
    ...EXIT_CRITERIA.map((c) => `  [ ] ${c}`),
    "",
    "--- METRICS TO RECORD ---",
    "  Pass rate        = passed / executed",
    "  Defect density   = defects found / size of feature (KLOC or story points)",
    "  Defect severity  = count by Critical / High / Medium / Low",
    "  Defect clustering= which module produced the most defects (test it harder next cycle)",
    "  Execution effort = planned hours vs actual hours"
  );

  const scriptedCount =
    happyPath.length +
    (isSmoke ? 0 : buildNegativeChecks(parameters).length + buildBoundaryChecks(parameters).length +
      (isExhaustive ? CONTEXTUAL_EDGE_CASES.length : Math.min(7, CONTEXTUAL_EDGE_CASES.length)));

  sections.push(
    "",
    "--- SUMMARY ---",
    `Environment steps  : ${ENVIRONMENT_SETUP.length}`,
    `Scripted checks    : ${scriptedCount}`,
    `Exploratory sessions: ${isSmoke ? 0 : buildExploratoryCharters(parameters, moduleInfo).length}`,
    `Exit criteria      : ${EXIT_CRITERIA.length}`
  );

  return toolText(sections.join("\n"));
}

/* ──────────────────────────────────────────────────────────────────────────
 * Tool 4 extensions: data-driven, responsive, UI states, VRT, a11y, BDD
 * (Senior-QA-Engineer.md section 3; UI-Testing.md sections 1-2)
 * ────────────────────────────────────────────────────────────────────────── */

/** Picks the steps that take a value, for data-driven and Gherkin generation. */
function valueSteps(steps) {
  return steps.filter((s) => s.action === "fill" || s.action === "select");
}

function emitDataDriven(framework, flowName, steps, fileSlug) {
  const target = valueSteps(steps)[0] ?? steps[0];
  const field = target ? target.testId : "input-field";
  const method = target ? target.method : "performStep";
  const pageRef = camelCase(`${flowName}${framework === "jest" ? "Screen" : "Page"}`);

  const dataset = `const CASES = [
  { name: "valid nominal value", input: "${sampleValueFor(target ?? { target: field })}", expectValid: true },
  { name: "empty value", input: "", expectValid: false },
  { name: "whitespace only", input: "   ", expectValid: false },
  { name: "maximum supported length", input: "x".repeat(255), expectValid: false },
  { name: "unicode and emoji", input: "日本語 🚀", expectValid: true },
  { name: "injection payload", input: "' OR 1=1 --", expectValid: false },
];`;

  if (framework === "playwright") {
    return `// ─── file: tests/${fileSlug}.data-driven.spec.js ──────────────────
// Data-Driven Testing: the script is separate from the dataset. Replace CASES
// with a fixture file or database query to scale coverage without new code.
import { test, expect } from "@playwright/test";
import { ${pascalCase(flowName)}Page } from "../pages/${pascalCase(flowName)}Page.js";

${dataset}

for (const testCase of CASES) {
  test(\`${field} — \${testCase.name}\`, async ({ page }) => {
    const ${pageRef} = new ${pascalCase(flowName)}Page(page);
    await ${pageRef}.${method}(testCase.input);
    const error = page.getByTestId("${field}-error");
    if (testCase.expectValid) {
      await expect(error).toHaveCount(0);
    } else {
      await expect(error).toBeVisible();
    }
  });
}
`;
  }

  if (framework === "cypress") {
    return `// ─── file: cypress/e2e/${fileSlug}.data-driven.cy.js ───────────────
// Data-Driven Testing: swap CASES for cy.fixture() to externalise the dataset.
import ${pageRef} from "../pages/${pascalCase(flowName)}Page.js";

${dataset}

describe("${flowName} — data driven", () => {
  CASES.forEach((testCase) => {
    it(\`${field} — \${testCase.name}\`, () => {
      ${pageRef}.${method}(testCase.input);
      cy.get('[data-testid="${field}-error"]').should(
        testCase.expectValid ? "not.exist" : "be.visible"
      );
    });
  });
});
`;
  }

  return `// ─── file: __tests__/${fileSlug}.data-driven.test.js ───────────────
/**
 * @jest-environment jsdom
 * Data-Driven Testing via test.each — one script, many datasets.
 */
import "@testing-library/jest-dom";
import { screen } from "@testing-library/react";
import { ${pascalCase(flowName)}Screen } from "./pages/${pascalCase(flowName)}Screen.js";

${dataset}

describe("${flowName} — data driven", () => {
  it.each(CASES)("${field} — $name", async ({ input, expectValid }) => {
    const ${pageRef} = new ${pascalCase(flowName)}Screen();
    await ${pageRef}.${method}(input);
    const error = screen.queryByTestId("${field}-error");
    if (expectValid) {
      expect(error).not.toBeInTheDocument();
    } else {
      expect(error).toBeInTheDocument();
    }
  });
});
`;
}

function emitResponsive(framework, flowName, steps, fileSlug) {
  const viewportList = VIEWPORTS.map(
    (v) => `  { name: "${kebabCase(v.label)}", width: ${v.width}, height: ${v.height} },`
  ).join("\n");

  if (framework === "playwright") {
    return `// ─── file: playwright.config.js (excerpt) ─────────────────────────
// Cross-browser rendering across all three engines: Blink, WebKit, Gecko.
import { devices } from "@playwright/test";

export default {
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },  // Blink
    { name: "webkit",   use: { ...devices["Desktop Safari"] } },  // WebKit
    { name: "firefox",  use: { ...devices["Desktop Firefox"] } }, // Gecko
    { name: "mobile-safari", use: { ...devices["iPhone 13"] } },
  ],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
};

// ─── file: tests/${fileSlug}.responsive.spec.js ───────────────────
// Responsive + Visual Regression. Baselines are per project, so each engine
// and viewport combination is compared against its own reference image.
import { test, expect } from "@playwright/test";
import { ${pascalCase(flowName)}Page } from "../pages/${pascalCase(flowName)}Page.js";

const VIEWPORTS = [
${viewportList}
];

for (const viewport of VIEWPORTS) {
  test(\`${flowName} renders at \${viewport.name}\`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const ${camelCase(flowName)}Page = new ${pascalCase(flowName)}Page(page);
    await ${camelCase(flowName)}Page.${steps[0]?.method ?? "open"}();

    // No horizontal overflow at any supported width.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflows, \`horizontal scrollbar at \${viewport.name}\`).toBe(false);

    await expect(page).toHaveScreenshot(\`${fileSlug}-\${viewport.name}.png\`, {
      fullPage: true,
      animations: "disabled",           // settle motion to avoid false positives
      mask: [page.getByTestId("timestamp"), page.getByTestId("avatar")], // dynamic regions
    });
  });
}
`;
  }

  if (framework === "cypress") {
    return `// ─── file: cypress/e2e/${fileSlug}.responsive.cy.js ────────────────
// Requires cypress-image-snapshot for the visual regression assertions.
import ${camelCase(flowName)}Page from "../pages/${pascalCase(flowName)}Page.js";

const VIEWPORTS = [
${viewportList}
];

describe("${flowName} — responsive", () => {
  VIEWPORTS.forEach((viewport) => {
    it(\`renders at \${viewport.name}\`, () => {
      cy.viewport(viewport.width, viewport.height);
      ${camelCase(flowName)}Page.${steps[0]?.method ?? "open"}();

      cy.document().then((doc) => {
        expect(
          doc.documentElement.scrollWidth,
          \`horizontal scrollbar at \${viewport.name}\`
        ).to.be.at.most(doc.documentElement.clientWidth);
      });

      cy.matchImageSnapshot(\`${fileSlug}-\${viewport.name}\`, {
        failureThreshold: 0.01,
        failureThresholdType: "percent",
      });
    });
  });
});

// NOTE: Cypress runs on Chromium, Firefox, and WebKit (experimental). Run the
// suite once per browser in CI: cypress run --browser chrome|firefox|webkit
`;
  }

  return `// ─── file: __tests__/${fileSlug}.responsive.test.js ────────────────
/**
 * @jest-environment jsdom
 * jsdom has no layout engine, so it cannot verify rendering or capture pixels.
 * Assert responsive BEHAVIOUR here (which elements mount per breakpoint) and
 * leave visual regression to Playwright or Cypress.
 */
import "@testing-library/jest-dom";
import { screen } from "@testing-library/react";

const VIEWPORTS = [
${viewportList}
];

function setViewport(width, height) {
  window.innerWidth = width;
  window.innerHeight = height;
  window.matchMedia = (query) => ({
    matches: matchMediaQuery(query, width),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  window.dispatchEvent(new Event("resize"));
}

function matchMediaQuery(query, width) {
  const min = query.match(/min-width:\\s*(\\d+)px/);
  const max = query.match(/max-width:\\s*(\\d+)px/);
  if (min && width < Number(min[1])) return false;
  if (max && width > Number(max[1])) return false;
  return true;
}

describe("${flowName} — responsive behaviour", () => {
  it.each(VIEWPORTS)("mounts the correct layout at $name", ({ width, height }) => {
    setViewport(width, height);
    // TODO: render the component and assert the breakpoint-specific affordance,
    // e.g. a hamburger menu below 768px and a full nav bar above it.
    expect(window.innerWidth).toBe(width);
  });
});
`;
}

function emitUiStates(framework, flowName, steps, fileSlug) {
  const interactive = steps.find((s) => s.action === "click") ?? steps[0];
  const locator = interactive ? interactive.testId : "primary-action";

  if (framework === "playwright") {
    return `// ─── file: tests/${fileSlug}.states.spec.js ────────────────────────
// Interactive component states: default, hover, focus, active, disabled, loading.
import { test, expect } from "@playwright/test";

test.describe("${flowName} — component states", () => {
  test("hover does not shift layout", async ({ page }) => {
    const control = page.getByTestId("${locator}");
    const before = await control.boundingBox();
    await control.hover();
    const after = await control.boundingBox();
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
  });

  test("focus ring is visible and keyboard reachable", async ({ page }) => {
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toBeVisible();
    const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline, "focus indicator must not be suppressed").not.toBe("none");
  });

  test("disabled control is inert and announced", async ({ page }) => {
    const control = page.getByTestId("${locator}");
    if (await control.isDisabled()) {
      await expect(control).toHaveAttribute("aria-disabled", "true");
      await control.click({ force: true, trial: true }).catch(() => {});
    }
  });

  test("loading state locks against double submission", async ({ page }) => {
    const control = page.getByTestId("${locator}");
    await control.click();
    await expect(control).toBeDisabled();           // must lock immediately
    await expect(page.getByTestId("loading")).toBeVisible();
  });

  test("empty and error states are explanatory", async ({ page }) => {
    const empty = page.getByTestId("empty-state");
    if (await empty.count()) await expect(empty).toContainText(/\\w{10,}/);
    const error = page.getByTestId("error-message");
    if (await error.count()) await expect(error).toHaveAttribute("role", "alert");
  });
});
`;
  }

  if (framework === "cypress") {
    return `// ─── file: cypress/e2e/${fileSlug}.states.cy.js ────────────────────
describe("${flowName} — component states", () => {
  it("hover does not shift layout", () => {
    cy.get('[data-testid="${locator}"]').then(($el) => {
      const before = $el[0].getBoundingClientRect();
      cy.get('[data-testid="${locator}"]').trigger("mouseover").then(($after) => {
        const after = $after[0].getBoundingClientRect();
        expect(after.x).to.be.closeTo(before.x, 1);
        expect(after.y).to.be.closeTo(before.y, 1);
      });
    });
  });

  it("focus ring is visible and keyboard reachable", () => {
    cy.get('[data-testid="${locator}"]').focus().should("be.focused");
    cy.focused().should(($el) => {
      expect(getComputedStyle($el[0]).outlineStyle).to.not.equal("none");
    });
  });

  it("disabled control is inert and announced", () => {
    cy.get('[data-testid="${locator}"]').then(($el) => {
      if ($el.is(":disabled")) {
        cy.wrap($el).should("have.attr", "aria-disabled", "true");
      }
    });
  });

  it("loading state locks against double submission", () => {
    cy.get('[data-testid="${locator}"]').click();
    cy.get('[data-testid="${locator}"]').should("be.disabled");
    cy.get('[data-testid="loading"]').should("be.visible");
  });
});
`;
  }

  return `// ─── file: __tests__/${fileSlug}.states.test.js ────────────────────
/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

describe("${flowName} — component states", () => {
  it("focus is reachable by keyboard", async () => {
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("disabled control is announced to assistive technology", () => {
    const control = screen.queryByTestId("${locator}");
    if (control && control.hasAttribute("disabled")) {
      expect(control).toHaveAttribute("aria-disabled", "true");
    }
  });

  it("loading state locks against double submission", async () => {
    const user = userEvent.setup();
    const control = screen.getByTestId("${locator}");
    await user.click(control);
    expect(control).toBeDisabled();
  });

  it("error message is announced via a live region", () => {
    const error = screen.queryByTestId("error-message");
    if (error) expect(error).toHaveAttribute("role", "alert");
  });
});
`;
}

function emitAccessibility(framework, flowName, fileSlug) {
  if (framework === "playwright") {
    return `// ─── file: tests/${fileSlug}.a11y.spec.js ──────────────────────────
// Automated scanning covers roughly a third of WCAG. Pair this with the manual
// keyboard and screen-reader checks from generate_ui_ux_checklist.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("${flowName} — accessibility", () => {
  test("has no detectable WCAG 2.1 A/AA violations", async ({ page }) => {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const summary = results.violations.map(
      (v) => \`\${v.id} (\${v.impact}) x\${v.nodes.length}: \${v.help}\`
    );
    expect(summary, summary.join("\\n")).toEqual([]);
  });

  test("zooms to 200% without horizontal scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 800 }); // ~200% of 1280
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflows).toBe(false);
  });
});
`;
  }

  if (framework === "cypress") {
    return `// ─── file: cypress/e2e/${fileSlug}.a11y.cy.js ──────────────────────
// Requires cypress-axe: import "cypress-axe" in cypress/support/e2e.js
describe("${flowName} — accessibility", () => {
  beforeEach(() => {
    cy.injectAxe();
  });

  it("has no detectable WCAG 2.1 A/AA violations", () => {
    cy.checkA11y(null, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
  });
});
`;
  }

  return `// ─── file: __tests__/${fileSlug}.a11y.test.js ──────────────────────
/**
 * @jest-environment jsdom
 * Requires jest-axe.
 */
import { axe, toHaveNoViolations } from "jest-axe";
expect.extend(toHaveNoViolations);

describe("${flowName} — accessibility", () => {
  it("has no detectable WCAG violations", async () => {
    const { container } = render(<${pascalCase(flowName)} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
`;
}

const GHERKIN_KEYWORD = {
  navigate: "Given",
  login: "Given",
  logout: "When",
  fill: "When",
  select: "When",
  upload: "When",
  check: "When",
  click: "When",
  wait: "When",
  assert: "Then",
};

function emitBdd(flowName, steps, flowDescription, fileSlug) {
  const lines = [];
  let lastKeyword = null;

  for (const step of steps) {
    const keyword = GHERKIN_KEYWORD[step.action] ?? "When";
    const text = step.text.replace(/^(?:the\s+)?user\s+/i, "I ").trim();
    lines.push(`    ${keyword === lastKeyword ? "And" : keyword} ${text}`);
    lastKeyword = keyword;
  }
  if (!lines.some((l) => l.includes("Then"))) {
    lines.push("    Then I should see the expected confirmation");
  }

  const valued = valueSteps(steps)[0];
  const field = valued ? valued.target : "the input";

  return `// ─── file: features/${fileSlug}.feature ────────────────────────────
# Behaviour-Driven Development: plain language shared by product, QA, and
# engineering. Bind each step to the Page Object Model above via step
# definitions (Cucumber, cucumber-js, or @cucumber/playwright).

Feature: ${flowName}
  As a user
  I want to ${flowDescription}
  So that the outcome is correct and repeatable

  Background:
    Given the application is available
    And I am starting from a clean session

  Scenario: Happy path
${lines.join("\n")}

  Scenario Outline: ${field} validation
    Given I am on the ${flowName} screen
    When I enter "<value>" into ${field}
    Then I should see "<outcome>"

    Examples:
      | value              | outcome                       |
      |                    | a required-field error        |
      | valid input        | no error                      |
      | ' OR 1=1 --        | the value treated as literal  |
      | <255-character>    | a maximum-length error        |
`;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Tool 7: generate_api_contract_tests
 *
 * Component / API layer of the testing pyramid (Testing-Types.md section 1):
 * endpoints, status codes, payload and schema contracts, auth boundaries, and
 * error envelopes — verified without a UI.
 * ────────────────────────────────────────────────────────────────────────── */

const API_FRAMEWORKS = ["supertest", "playwright", "pytest"];

/** Status contract per HTTP verb: [code, condition]. */
const STATUS_CONTRACT = {
  GET: [
    ["200", "a valid request returns the documented representation"],
    ["400", "a malformed query parameter is rejected"],
    ["401", "a request without credentials is rejected"],
    ["403", "a caller without entitlement is rejected"],
    ["404", "an unknown identifier returns not-found, not an empty 200"],
    ["429", "requests beyond the rate limit are throttled with Retry-After"],
  ],
  POST: [
    ["201", "a valid payload creates the resource and returns its location"],
    ["400", "a missing required field is rejected with a field-level error"],
    ["401", "a request without credentials is rejected"],
    ["403", "a caller without entitlement is rejected"],
    ["409", "a duplicate creation is rejected rather than silently overwriting"],
    ["422", "a semantically invalid payload is rejected"],
  ],
  PUT: [
    ["200", "a valid replacement returns the updated representation"],
    ["400", "a malformed payload is rejected"],
    ["401", "a request without credentials is rejected"],
    ["403", "a caller without entitlement is rejected"],
    ["404", "updating an unknown identifier returns not-found"],
    ["409", "a stale version or ETag mismatch is rejected"],
  ],
  PATCH: [
    ["200", "a valid partial update returns the updated representation"],
    ["400", "an unknown or malformed field is rejected"],
    ["401", "a request without credentials is rejected"],
    ["403", "a caller without entitlement is rejected"],
    ["404", "patching an unknown identifier returns not-found"],
    ["422", "a semantically invalid value is rejected"],
  ],
  DELETE: [
    ["204", "a valid deletion returns no content"],
    ["401", "a request without credentials is rejected"],
    ["403", "a caller without entitlement is rejected"],
    ["404", "deleting an unknown identifier returns not-found"],
    ["409", "deletion blocked by a dependency is rejected with an explanation"],
  ],
};

const UNIVERSAL_CONTRACTS = [
  "Response Content-Type is application/json with an explicit charset.",
  "Error responses share one envelope shape across every status code.",
  "No stack trace, SQL fragment, or internal path appears in any error body.",
  "Unknown request fields are either rejected or ignored — consistently, and documented.",
  "The same request issued twice produces the documented idempotency behaviour.",
  "Timestamps are ISO 8601 with an explicit timezone offset.",
  "Numeric identifiers are returned as strings if they can exceed 2^53.",
  "CORS headers match the documented allowed origins.",
  "Response time stays within the agreed budget under nominal load.",
];

function parseEndpoints(spec) {
  const endpoints = [];
  const seen = new Set();

  for (const m of spec.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s"'`,)\]]*)/gi)) {
    const method = m[1].toUpperCase();
    const path = m[2];
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({ method, path, kind: "rest" });
  }

  for (const m of spec.matchAll(/\b(query|mutation|subscription)\s+(\w+)/gi)) {
    const key = `${m[1].toLowerCase()} ${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({ method: m[1].toLowerCase(), path: m[2], kind: "graphql" });
  }

  return endpoints.slice(0, 10);
}

function endpointSlug(endpoint) {
  return kebabCase(`${endpoint.method} ${endpoint.path.replace(/[{}:]/g, " ")}`) || "endpoint";
}

function buildSamplePayload(parameters) {
  if (parameters.length === 0) return `{ /* TODO: populate from the specification */ }`;
  const entries = parameters.slice(0, 8).map((p) => {
    switch (p.type) {
      case "number": return `    ${p.name}: ${p.constraints.min ?? 1}`;
      case "boolean": return `    ${p.name}: true`;
      case "enum": return `    ${p.name}: ${JSON.stringify(p.constraints.enum?.[0] ?? "value")}`;
      case "array": return `    ${p.name}: []`;
      case "date": return `    ${p.name}: "2024-01-15T00:00:00Z"`;
      default: return `    ${p.name}: ${JSON.stringify(sampleValueFor({ target: p.name }))}`;
    }
  });
  return `{\n${entries.join(",\n")}\n  }`;
}

function emitSupertest(endpoints, parameters, specName) {
  const payload = buildSamplePayload(parameters);
  const required = parameters.filter((p) => p.constraints.required || !p.constraints.optional);
  const blocks = endpoints.map((endpoint) => {
    const statuses = STATUS_CONTRACT[endpoint.method] ?? STATUS_CONTRACT.GET;
    const call =
      endpoint.method === "GET" || endpoint.method === "DELETE"
        ? `.${endpoint.method.toLowerCase()}("${endpoint.path}")`
        : `.${endpoint.method.toLowerCase()}("${endpoint.path}").send(VALID_PAYLOAD)`;

    const statusTests = statuses
      .map(([code, condition]) => {
        const setup =
          code === "401" ? "\n      // no Authorization header"
            : code === "403" ? "\n      .set(\"Authorization\", `Bearer ${LOW_PRIVILEGE_TOKEN}`)"
            : "\n      .set(\"Authorization\", `Bearer ${TOKEN}`)";
        return `  it("${code} — ${condition}", async () => {
    await request(app)
      ${call}${setup}
      .expect(${code});
  });`;
      })
      .join("\n\n");

    const fieldTests = required
      .slice(0, 5)
      .map(
        (p) => `  it("400 — rejects a payload missing ${p.name}", async () => {
    const { ${p.name}: _omitted, ...incomplete } = VALID_PAYLOAD;
    const res = await request(app)
      .${(endpoint.method === "GET" ? "post" : endpoint.method.toLowerCase())}("${endpoint.path}")
      .set("Authorization", \`Bearer \${TOKEN}\`)
      .send(incomplete)
      .expect(400);
    expect(res.body.error).toBeDefined();
    expect(JSON.stringify(res.body)).toContain("${p.name}");
  });`
      )
      .join("\n\n");

    return `describe("${endpoint.method} ${endpoint.path} — contract", () => {
${statusTests}

${fieldTests}

  it("returns the documented response schema", async () => {
    const res = await request(app)
      ${call}
      .set("Authorization", \`Bearer \${TOKEN}\`);
    expect(res.headers["content-type"]).toMatch(/application\\/json/);
    // TODO: assert against the published JSON Schema / OpenAPI component.
    expect(res.body).toBeDefined();
  });

  it("error envelope is consistent", async () => {
    const res = await request(app)
      .${endpoint.method.toLowerCase()}("${endpoint.path}")
      .set("Authorization", "Bearer invalid")
      .send(${endpoint.method === "GET" || endpoint.method === "DELETE" ? "" : "VALID_PAYLOAD"});
    if (res.status >= 400) {
      expect(res.body).toHaveProperty("error");
      expect(JSON.stringify(res.body)).not.toMatch(/at \\w+ \\(|SELECT |node_modules/);
    }
  });
});`;
  });

  return `// ─── file: __tests__/${kebabCase(specName)}.contract.test.js ──────────
// API contract tests — the middle tier of the testing pyramid. No UI involved.
import request from "supertest";
import app from "../src/app.js";

const TOKEN = process.env.TEST_TOKEN ?? "replace-with-a-valid-token";
const LOW_PRIVILEGE_TOKEN = process.env.TEST_LOW_TOKEN ?? "replace-with-a-reader-token";

const VALID_PAYLOAD = ${payload};

${blocks.join("\n\n")}
`;
}

function emitPlaywrightApi(endpoints, parameters, specName) {
  const payload = buildSamplePayload(parameters);
  const blocks = endpoints.map((endpoint) => {
    const statuses = STATUS_CONTRACT[endpoint.method] ?? STATUS_CONTRACT.GET;
    const body =
      endpoint.method === "GET" || endpoint.method === "DELETE" ? "" : ", { data: VALID_PAYLOAD }";
    const statusTests = statuses
      .map(
        ([code, condition]) => `  test("${code} — ${condition}", async ({ request }) => {
    const response = await request.${endpoint.method.toLowerCase()}("${endpoint.path}"${body});
    expect(response.status()).toBe(${code});
  });`
      )
      .join("\n\n");

    return `test.describe("${endpoint.method} ${endpoint.path} — contract", () => {
${statusTests}

  test("returns JSON matching the documented schema", async ({ request }) => {
    const response = await request.${endpoint.method.toLowerCase()}("${endpoint.path}"${body});
    expect(response.headers()["content-type"]).toContain("application/json");
    const body_ = await response.json();
    expect(body_).toBeDefined();
  });

  test("error body leaks no internals", async ({ request }) => {
    const response = await request.${endpoint.method.toLowerCase()}("${endpoint.path}/does-not-exist");
    if (response.status() >= 400) {
      const text_ = await response.text();
      expect(text_).not.toMatch(/at \\w+ \\(|SELECT |node_modules/);
    }
  });
});`;
  });

  return `// ─── file: tests/${kebabCase(specName)}.contract.spec.js ──────────────
// Playwright API testing — runs without a browser page.
import { test, expect } from "@playwright/test";

const VALID_PAYLOAD = ${payload};

// playwright.config.js: use: { baseURL: process.env.API_BASE_URL,
//   extraHTTPHeaders: { Authorization: \`Bearer \${process.env.TEST_TOKEN}\` } }

${blocks.join("\n\n")}
`;
}

function emitPytestApi(endpoints, parameters, specName) {
  const pyPayload = parameters.length
    ? parameters
        .slice(0, 8)
        .map((p) => {
          switch (p.type) {
            case "number": return `    "${p.name}": ${p.constraints.min ?? 1},`;
            case "boolean": return `    "${p.name}": True,`;
            case "enum": return `    "${p.name}": "${p.constraints.enum?.[0] ?? "value"}",`;
            case "array": return `    "${p.name}": [],`;
            default: return `    "${p.name}": "${sampleValueFor({ target: p.name })}",`;
          }
        })
        .join("\n")
    : '    # TODO: populate from the specification';

  const blocks = endpoints.map((endpoint) => {
    const statuses = STATUS_CONTRACT[endpoint.method] ?? STATUS_CONTRACT.GET;
    const fn = endpoint.method.toLowerCase();
    const body = fn === "get" || fn === "delete" ? "" : ", json=VALID_PAYLOAD";
    const slug = endpointSlug(endpoint).replace(/-/g, "_");

    const statusTests = statuses
      .map(
        ([code, condition]) => `def test_${slug}_${code}(client):
    """${code} — ${condition}"""
    response = client.${fn}("${endpoint.path}"${body})
    assert response.status_code == ${code}`
      )
      .join("\n\n\n");

    return `${statusTests}


def test_${slug}_schema(client):
    """Response matches the documented schema and content type."""
    response = client.${fn}("${endpoint.path}"${body})
    assert "application/json" in response.headers["content-type"]
    assert response.json() is not None


def test_${slug}_error_envelope(client):
    """Error bodies share one shape and leak no internals."""
    response = client.${fn}("${endpoint.path}/does-not-exist")
    if response.status_code >= 400:
        assert "error" in response.json()
        assert "Traceback" not in response.text`;
  });

  return `# ─── file: tests/test_${kebabCase(specName).replace(/-/g, "_")}_contract.py ──────
# API contract tests — the middle tier of the testing pyramid.
import pytest

VALID_PAYLOAD = {
${pyPayload}
}


${blocks.join("\n\n\n")}
`;
}

const API_EMITTERS = {
  supertest: emitSupertest,
  playwright: emitPlaywrightApi,
  pytest: emitPytestApi,
};

function handleGenerateApiContractTests(args) {
  const { apiSpec, framework } = validateArgs(args, {
    apiSpec: { required: true, preserveWhitespace: true },
    framework: { required: false, enum: API_FRAMEWORKS, default: "supertest", maxLength: 32 },
  });

  const { source } = normalizeSource(apiSpec);
  const endpoints = parseEndpoints(source);
  const discovered = extractParameters(source);
  const parameters = discovered.map((p) => {
    const context = gatherContext(source, p.name);
    const constraints = extractConstraints(context, p.rawType);
    return { ...p, constraints, type: inferType(p.name, p.rawType, constraints) };
  });

  const specName = deriveFeatureName(apiSpec);

  if (endpoints.length === 0) {
    return toolText(
      [
        "=== API CONTRACT TESTS ===",
        "",
        "No endpoints could be extracted from this specification.",
        "",
        "Supply one of the following:",
        "  - REST routes in the form: POST /api/v1/orders",
        "  - an OpenAPI path block",
        "  - GraphQL operations in the form: mutation createOrder",
        "",
        "--- UNIVERSAL CONTRACT CHECKLIST (applies to every endpoint) ---",
        ...UNIVERSAL_CONTRACTS.map((c) => `  [ ] ${c}`),
      ].join("\n")
    );
  }

  const emit = API_EMITTERS[framework];
  const totalCases = endpoints.reduce(
    (sum, e) => sum + (STATUS_CONTRACT[e.method] ?? STATUS_CONTRACT.GET).length + 2,
    0
  );

  const c = framework === "pytest" ? "#" : "//";
  const header = [
    `${c} Framework : ${framework}`,
    `${c} Spec      : ${specName}`,
    `${c} Endpoints : ${endpoints.length} detected — ${endpoints.map((e) => `${e.method} ${e.path}`).join(", ")}`,
    `${c} Fields    : ${parameters.length} detected`,
    `${c} Cases     : ~${totalCases} generated`,
    "",
  ].join("\n");

  const checklist = [
    "",
    framework === "pytest" ? "# --- UNIVERSAL CONTRACT CHECKLIST ---" : "// --- UNIVERSAL CONTRACT CHECKLIST ---",
    ...UNIVERSAL_CONTRACTS.map((c) => (framework === "pytest" ? `#   [ ] ${c}` : `//   [ ] ${c}`)),
  ].join("\n");

  return toolText(header + emit(endpoints, parameters, specName) + checklist);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Tool 8: generate_test_strategy
 *
 * The STLC planning and closure layer (Senior-QA-Engineer.md sections 1-3, 6):
 * context analysis, pyramid allocation, test type selection, non-functional
 * planning, release validation, CI gating, and closure metrics.
 * ────────────────────────────────────────────────────────────────────────── */

const RISK_PROFILES = ["prototype", "standard", "regulated"];

const DOMAIN_SIGNALS = [
  { re: /e-?commerce|checkout|cart|storefront|retail|marketplace/i, domain: "e-commerce", critical: "Payment accuracy, inventory consistency, and cart integrity under concurrency." },
  { re: /fintech|bank|payment|ledger|trading|invoice|billing|payroll/i, domain: "financial", critical: "Monetary correctness to the smallest unit, auditability, and idempotent transactions." },
  { re: /health|patient|clinical|medical|ehr|hipaa/i, domain: "healthcare", critical: "Patient data confidentiality, clinical accuracy, and full audit trails." },
  { re: /\bsaas\b|dashboard|tenant|subscription|workspace/i, domain: "multi-tenant SaaS", critical: "Tenant isolation — no query may ever cross a tenant boundary." },
  { re: /mobile|ios|android|react native|flutter/i, domain: "mobile", critical: "Device and OS fragmentation, offline behaviour, and background/foreground transitions." },
  { re: /\bapi\b|microservice|backend|grpc|graphql/i, domain: "service/API", critical: "Contract stability, backward compatibility, and graceful degradation." },
  { re: /\biot\b|device|firmware|embedded|sensor/i, domain: "IoT/embedded", critical: "Intermittent connectivity, constrained resources, and over-the-air update safety." },
  { re: /\bml\b|machine learning|\bai\b|model|inference|llm/i, domain: "ML/AI", critical: "Non-determinism, drift detection, and bounded output validation." },
];

const COMPLIANCE_SIGNALS = [
  { re: /\bpci\b|card data|cardholder/i, label: "PCI DSS", demand: "No PAN in logs; segmented cardholder data environment; quarterly scans." },
  { re: /\bhipaa\b|\bphi\b/i, label: "HIPAA", demand: "PHI encrypted at rest and in transit; access audit log; signed BAAs." },
  { re: /\bgdpr\b|right to be forgotten|data subject/i, label: "GDPR", demand: "Erasure and export verified end to end; lawful-basis records; consent withdrawal." },
  { re: /\bsox\b|financial report/i, label: "SOX", demand: "Change control evidence; segregation of duties; immutable audit trail." },
  { re: /\bwcag\b|accessib|a11y|section 508/i, label: "WCAG / Section 508", demand: "AA conformance verified by audit, not only automated scanning." },
];

const CORE_PRINCIPLES = [
  { name: "Testing shows the presence of defects, not their absence", apply: "Report residual risk alongside pass rate. A green suite is evidence, not proof." },
  { name: "Exhaustive testing is impossible", apply: "Allocate effort by risk. The highest-risk flows below get depth; the rest get breadth." },
  { name: "Early testing (shift-left)", apply: "Run generate_qa_matrix against the specification before implementation starts." },
  { name: "Defect clustering (Pareto)", apply: "Track defects per module. When one module produces the most, test it harder next cycle." },
  { name: "The pesticide paradox", apply: "Rotate and extend the suite each cycle; add the exploratory charters that automation cannot replace." },
  { name: "Testing is context-dependent", apply: "This strategy is tailored to the domain and risk tier detected below — do not reuse it verbatim elsewhere." },
  { name: "Absence-of-errors fallacy", apply: "Validate against user need, not only the specification. UAT is the gate that catches this." },
];

const PYRAMID = [
  { tier: "Unit", share: "70%", scope: "Single functions, hooks, reducers, pure logic. All dependencies mocked.", speed: "< 10ms each", owner: "Developer", tool: "Jest / Vitest / pytest" },
  { tier: "Integration / API", share: "20%", scope: "Contracts between modules, services, and the database. Real I/O, no UI.", speed: "< 1s each", owner: "Developer + QA", tool: "supertest / Playwright API / pytest" },
  { tier: "End-to-End UI", share: "10%", scope: "Critical user journeys through the full stack.", speed: "< 60s each", owner: "QA", tool: "Playwright / Cypress" },
];

const NON_FUNCTIONAL_PLAN = [
  { type: "Load", objective: "Behaviour at expected peak traffic", trigger: "Every release touching a request path", exit: "p95 latency within budget; error rate < 0.1%" },
  { type: "Stress", objective: "Find the breaking point and the failure mode", trigger: "Quarterly, and before a major launch", exit: "Degrades gracefully; recovers without manual intervention" },
  { type: "Endurance (Soak)", objective: "Memory leaks and resource exhaustion over 24-72h", trigger: "Before each major release", exit: "Flat memory profile; no connection pool growth" },
  { type: "Spike", objective: "Reaction to a sudden traffic surge", trigger: "Before any campaign or launch event", exit: "Autoscaling engages; no cascading failure; queue drains" },
  { type: "Security / Pentest", objective: "Authentication, authorisation, and injection vulnerabilities", trigger: "Annually and on any auth change", exit: "No High or Critical findings open" },
  { type: "Accessibility", objective: "WCAG 2.1 AA conformance", trigger: "Every UI change", exit: "Zero automated violations; manual keyboard and screen-reader pass" },
  { type: "Compatibility", objective: "Consistent rendering across engines and viewports", trigger: "Every UI change", exit: "Blink, WebKit, and Gecko all pass at every supported breakpoint" },
];

const RELEASE_VALIDATION = [
  { phase: "Alpha", who: "Internal developers and QA", goal: "Catch critical defects before external exposure", gate: "No Critical defects open; smoke suite green" },
  { phase: "Beta", who: "Selected real-world users", goal: "Usability feedback and environment-diversity defects", gate: "Feedback triaged; no Critical regressions reported" },
  { phase: "UAT", who: "Client or business owner", goal: "Confirm the delivered business value", gate: "Formal sign-off against acceptance criteria" },
];

const AUTOMATE_GUIDANCE = {
  automate: [
    "Stable regression suites that run every commit.",
    "Deterministic boundary and equivalence cases from generate_qa_matrix.",
    "API contract tests — cheap, fast, and the highest value per line.",
    "Smoke suite gating every deployment.",
    "Accessibility scanning and visual regression baselines.",
  ],
  doNotAutomate: [
    "Exploratory testing — the value is in the human adapting mid-session.",
    "Usability and emotional friction — automation cannot measure frustration.",
    "Visual polish judgement beyond pixel diffing.",
    "Features whose requirements are still changing weekly — the suite will cost more than it saves.",
    "One-off data migrations verified once and never repeated.",
  ],
};

function detectDomain(context) {
  const matches = DOMAIN_SIGNALS.filter((s) => s.re.test(context));
  return matches.length ? matches : [{ domain: "general application", critical: "Correctness of the primary user journeys and data integrity." }];
}

function detectCompliance(context) {
  return COMPLIANCE_SIGNALS.filter((s) => s.re.test(context));
}

function detectScale(context) {
  const users = context.match(/([\d,.]+)\s*(k|m|million|thousand)?\s*(?:daily |monthly |concurrent )?(?:active )?users/i);
  const rps = context.match(/([\d,.]+)\s*(?:rps|req\/s|requests per second|tps)/i);
  const notes = [];
  if (users) notes.push(`user volume: ${users[0]}`);
  if (rps) notes.push(`throughput: ${rps[0]}`);
  return notes.length ? notes.join("; ") : "not stated — establish the expected peak before load testing";
}

function handleGenerateTestStrategy(args) {
  const { projectContext, riskProfile } = validateArgs(args, {
    projectContext: { required: true, preserveWhitespace: true },
    riskProfile: { required: false, enum: RISK_PROFILES, default: "standard", maxLength: 32 },
  });

  const domains = detectDomain(projectContext);
  const compliance = detectCompliance(projectContext);
  const scale = detectScale(projectContext);
  const isRegulated = riskProfile === "regulated" || compliance.length > 0;
  const isPrototype = riskProfile === "prototype";

  const sections = [
    "=== TEST STRATEGY & PLAN ===",
    `[Risk Profile]   ${riskProfile}${compliance.length && riskProfile !== "regulated" ? " (compliance signals detected — consider \"regulated\")" : ""}`,
    `[Domain]         ${domains.map((d) => d.domain).join(", ")}`,
    `[Scale]          ${scale}`,
    `[Compliance]     ${compliance.length ? compliance.map((c) => c.label).join(", ") : "none detected"}`,
    "",
    "--- CONTEXT-CRITICAL CONCERNS ---",
    "Testing is context-dependent. These are the concerns this domain fails on:",
    "",
    ...domains.map((d) => `  - ${d.domain}: ${d.critical}`),
  ];

  if (compliance.length) {
    sections.push(
      "",
      "--- COMPLIANCE OBLIGATIONS ---",
      renderTable(["Regime", "Testing Demand"], compliance.map((c) => [c.label, c.demand]))
    );
  }

  sections.push(
    "",
    "--- CORE PRINCIPLES APPLIED TO THIS PROJECT ---",
    ...CORE_PRINCIPLES.map((p) => `  ${p.name}\n    -> ${p.apply}`)
  );

  sections.push(
    "",
    "--- TEST PYRAMID ALLOCATION ---",
    "Distribute the automated portfolio for velocity and low maintenance.",
    "",
    renderTable(
      ["Tier", "Share", "Scope", "Budget", "Owner", "Tooling"],
      PYRAMID.map((t) => [t.tier, t.share, t.scope, t.speed, t.owner, t.tool])
    ),
    "",
    "An inverted pyramid (UI-heavy) is the single most common cause of a slow, flaky",
    "suite. If E2E exceeds 10%, push those assertions down a tier."
  );

  sections.push(
    "",
    "--- STLC PHASE PLAN ---",
    renderTable(
      ["Phase", "Activity", "Output", "Tool"],
      [
        ["1. Requirement Analysis", "Identify testable requirements and ambiguities", "Clarification list, testability review", "generate_qa_matrix"],
        ["2. Test Planning", "Scope, risk, resource, and schedule", "This document", "generate_test_strategy"],
        ["3. Test Design", "Derive cases from requirements", "BVA/EP matrix, decision tables, charters", "generate_qa_matrix, generate_manual_test_plan"],
        ["4. Environment Setup", "Provision data, fixtures, and config", "Reproducible environment", "generate_manual_test_plan (Phase A)"],
        ["5. Execution", "Run scripted and exploratory passes", "Results, defect records", "run_local_test_suite, parse_error_logs"],
        ["6. Cycle Closure", "Evaluate exit criteria and metrics", "Test Summary Report", "metrics section below"],
      ]
    )
  );

  const typeRows = [
    ["Unit", "Every commit", isPrototype ? "Medium" : "Critical", "Fastest feedback; carries 70% of coverage"],
    ["Integration / API", "Every commit", "Critical", "Where contract defects actually surface"],
    ["E2E UI", "Every merge to main", "High", "Critical journeys only"],
    ["Smoke", "Every deployment", "Critical", "Build verification before deeper testing"],
    ["Sanity", "After each bug fix", "High", "Narrow confirmation of the fix"],
    ["Regression", "Every release", "Critical", "Guards previously working behaviour"],
    ["Visual Regression", "Every UI change", isPrototype ? "Low" : "Medium", "Catches unintended layout drift"],
    ["Accessibility", "Every UI change", isRegulated ? "Critical" : "High", "Legal exposure and real user impact"],
    ["Compatibility", "Every UI change", "High", "Blink, WebKit, Gecko plus supported viewports"],
    ["Performance (Load)", "Every release touching a request path", isPrototype ? "Low" : "High", "Protects the latency budget"],
    ["Security / Pentest", "Annually and on auth changes", isRegulated ? "Critical" : "High", "Authorisation bypass is the costliest class"],
    ["UAT", "Before release", isPrototype ? "Low" : "Critical", "Guards against the absence-of-errors fallacy"],
  ];

  sections.push(
    "",
    "--- TEST TYPE SELECTION ---",
    renderTable(["Type", "Cadence", "Priority", "Rationale"], typeRows)
  );

  sections.push(
    "",
    "--- NON-FUNCTIONAL TEST PLAN ---",
    renderTable(
      ["Type", "Objective", "Trigger", "Exit Criterion"],
      NON_FUNCTIONAL_PLAN.map((n) => [n.type, n.objective, n.trigger, n.exit])
    )
  );

  sections.push(
    "",
    "--- VISIBILITY COVERAGE ---",
    "  Black-box : Requirement-driven cases from generate_qa_matrix. Primary technique.",
    "  White-box : Developer-owned. Target branch and statement coverage on business logic;",
    "              coverage percentage is a smoke alarm, not a goal.",
    "  Grey-box  : QA with database and log access — verify the persisted state after each",
    "              UI action, not just the rendered confirmation."
  );

  sections.push(
    "",
    "--- RELEASE VALIDATION ---",
    renderTable(
      ["Phase", "Participants", "Goal", "Exit Gate"],
      RELEASE_VALIDATION.map((r) => [r.phase, r.who, r.goal, r.gate])
    )
  );

  sections.push(
    "",
    "--- AUTOMATE vs TEST MANUALLY ---",
    "",
    "Automate:",
    ...AUTOMATE_GUIDANCE.automate.map((a) => `  [+] ${a}`),
    "",
    "Do not automate:",
    ...AUTOMATE_GUIDANCE.doNotAutomate.map((a) => `  [-] ${a}`)
  );

  sections.push(
    "",
    "--- CI/CD GATING POLICY ---",
    "  [ ] Unit and integration suites run on every pull request.",
    "  [ ] A single failing test blocks the merge. No exceptions, no re-run-until-green.",
    "  [ ] Smoke suite gates every deployment; failure triggers automatic rollback.",
    "  [ ] E2E runs on merge to main, sharded for wall-clock, not skipped for speed.",
    "  [ ] Flaky tests are quarantined with an owner and a deadline, never silently retried.",
    `  [ ] Coverage must not decrease${isRegulated ? "; regulated code paths require an explicit threshold." : "."}`,
    "  [ ] Accessibility and visual regression run on any UI diff."
  );

  sections.push(
    "",
    "--- TEST DATA ISOLATION ---",
    "  [ ] Each run seeds its own data; no two runs share a mutable record.",
    "  [ ] Transactional fixtures roll back, or each worker gets a dedicated schema.",
    "  [ ] No test depends on another test having run first.",
    "  [ ] External services are mocked or contract-tested, never called live in CI.",
    compliance.some((c) => c.label !== "WCAG / Section 508")
      ? "  [ ] Production data is never copied into a test environment unmasked."
      : "  [ ] Production-like data volumes used for performance runs."
  );

  const entry = [
    "Requirements reviewed and testable; ambiguities resolved.",
    "Build deployed to the test environment and smoke-verified.",
    "Test data and fixtures seeded.",
    "Test cases designed and peer-reviewed.",
  ];
  const exit = [
    "All planned cases executed; none left Not Run.",
    isPrototype ? "No Critical defects open." : "No Critical or High defects open.",
    "Every failure has a defect record with full reproduction evidence.",
    "Regression suite green on the release candidate.",
    "Non-functional exit criteria met for every triggered type.",
    "Test Summary Report published with metrics below.",
    isRegulated ? "Compliance evidence archived and signed off." : "Known limitations accepted by the product owner.",
  ];

  sections.push(
    "",
    "--- ENTRY CRITERIA ---",
    ...entry.map((c) => `  [ ] ${c}`),
    "",
    "--- EXIT CRITERIA ---",
    ...exit.map((c) => `  [ ] ${c}`)
  );

  sections.push(
    "",
    "--- CLOSURE METRICS ---",
    renderTable(
      ["Metric", "Formula", "Signal"],
      [
        ["Pass rate", "passed / executed", "Below 95% means the build was not ready"],
        ["Defect density", "defects / KLOC or story point", "Rising density concentrates next cycle's effort"],
        ["Defect clustering", "defects grouped by module", "The top module gets deeper testing next cycle"],
        ["Defect escape rate", "production defects / total found", "The honest measure of suite effectiveness"],
        ["Mean time to detect", "commit timestamp to failure timestamp", "Rising means feedback loops are degrading"],
        ["Automation coverage", "automated cases / total cases", "Track the trend, never the absolute number"],
        ["Flake rate", "non-deterministic runs / total runs", "Above 1% erodes trust in the whole suite"],
      ]
    )
  );

  sections.push(
    "",
    "--- RESIDUAL RISK ---",
    "Exhaustive testing is impossible. State plainly what this strategy does NOT cover:",
    "  - Input combinations beyond the selected boundary and partition representatives.",
    "  - Browser, device, and OS versions outside the supported matrix.",
    "  - Third-party outages and their cascading effects.",
    "  - Load patterns that differ in shape from the modelled peak.",
    isPrototype
      ? "  - At prototype risk tier, depth is deliberately traded for speed. Revisit before launch."
      : "  - Emergent behaviour under sustained real-world concurrency."
  );

  return toolText(sections.join("\n"));
}

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 2.1 / 2.2 — Tool registry and dispatch
 * ────────────────────────────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: "generate_qa_matrix",
    description:
      "Analyzes raw code diffs, function signatures, type declarations, or markdown requirements and derives a parametric Boundary Value Analysis matrix plus Equivalence Partitioning buckets for every detected parameter.",
    inputSchema: {
      type: "object",
      properties: {
        codeSnippet: {
          type: "string",
          description:
            "Source code, a git diff, a TypeScript interface, or markdown requirement bullets needing a test design plan.",
        },
      },
      required: ["codeSnippet"],
    },
    handler: handleGenerateQaMatrix,
  },
  {
    name: "run_local_test_suite",
    description:
      "Executes a local test command inside the workspace and returns the captured stdout/stderr, exit code, and triage summary. Only approved test runners are permitted; shell chaining and destructive commands are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            'The test command to execute, e.g. "npm test", "npm run test:coverage", "pytest -q".',
        },
      },
      required: ["command"],
    },
    handler: handleRunLocalTestSuite,
  },
  {
    name: "parse_error_logs",
    description:
      "Ingests raw terminal crashes, browser console output, or stack traces and returns a structured JSON defect record with reproduction steps, impacted code segments, error classification, and suggested fix vectors.",
    inputSchema: {
      type: "object",
      properties: {
        rawLogs: {
          type: "string",
          description: "The raw, unformatted error trace or log output.",
        },
        format: {
          type: "string",
          enum: ["json", "jira", "both"],
          description:
            'Output format. "json" is the machine-readable defect record (default). "jira" renders a ready-to-paste Jira wiki-markup bug report. "both" returns the Jira report followed by the JSON record.',
        },
      },
      required: ["rawLogs"],
    },
    handler: handleParseErrorLogs,
  },
  {
    name: "generate_automation_script",
    description:
      "Generates a production-ready Page Object Model automation script for the requested framework, derived from a plain-language description of the user flow.",
    inputSchema: {
      type: "object",
      properties: {
        framework: {
          type: "string",
          enum: SUPPORTED_FRAMEWORKS,
          description: "Target automation framework.",
        },
        flowDescription: {
          type: "string",
          description:
            'The user journey to automate, e.g. "user logs in, visits the billing screen, adds a valid credit card".',
        },
        coverage: {
          type: "string",
          enum: ["functional", "full"],
          description:
            'How much to emit. "functional" is the Page Object Model and happy/negative spec only. "full" adds data-driven, responsive + visual regression, component state, accessibility, and BDD artifacts. Defaults to "full".',
        },
      },
      required: ["framework", "flowDescription"],
    },
    handler: handleGenerateAutomationScript,
  },
  {
    name: "generate_ui_ux_checklist",
    description:
      "Acts as a Lead UI/UX Auditor. Analyses a requirements page or list of user journeys and produces a responsive viewport matrix, cross-browser rendering matrix, visual regression targets, interactive component state checks, WCAG 2.1 AA criteria, UX usability metrics, and the highest-risk flows a human tester should verify manually.",
    inputSchema: {
      type: "object",
      properties: {
        requirements: {
          type: "string",
          description:
            "A requirements page, feature specification, or list of user journeys to audit.",
        },
        scope: {
          type: "string",
          enum: ["full", "responsive", "accessibility", "ux"],
          description:
            "Which portion of the audit to emit. Defaults to \"full\".",
        },
      },
      required: ["requirements"],
    },
    handler: handleGenerateUiUxChecklist,
  },
  {
    name: "generate_manual_test_plan",
    description:
      "Produces a human-executable manual test plan from a feature specification: environment setup, happy-path checklist, negative-path and boundary passes, contextual edge cases, timeboxed exploratory charters, a defect report template, and STLC exit criteria with closure metrics.",
    inputSchema: {
      type: "object",
      properties: {
        featureSpec: {
          type: "string",
          description:
            "The feature specification, user story, or requirements text to build a manual test plan from.",
        },
        depth: {
          type: "string",
          enum: ["smoke", "standard", "exhaustive"],
          description:
            "How much of the plan to emit. \"smoke\" is happy path only; \"exhaustive\" includes every contextual edge case. Defaults to \"standard\".",
        },
      },
      required: ["featureSpec"],
    },
    handler: handleGenerateManualTestPlan,
  },
  {
    name: "generate_api_contract_tests",
    description:
      "Generates component/API contract tests from a REST, OpenAPI, or GraphQL specification: status-code contracts per verb, request payload validation, response schema and content-type assertions, authentication and authorisation boundaries, error-envelope consistency, and a universal contract checklist. Covers the middle tier of the testing pyramid without a UI.",
    inputSchema: {
      type: "object",
      properties: {
        apiSpec: {
          type: "string",
          description:
            "The API specification: REST routes (e.g. \"POST /api/v1/orders\"), an OpenAPI path block, or GraphQL operations, optionally with field definitions.",
        },
        framework: {
          type: "string",
          enum: ["supertest", "playwright", "pytest"],
          description: "Target test framework. Defaults to \"supertest\".",
        },
      },
      required: ["apiSpec"],
    },
    handler: handleGenerateApiContractTests,
  },
  {
    name: "generate_test_strategy",
    description:
      "Produces an STLC test strategy and plan tailored to a project: context and compliance analysis, core testing principles applied to the domain, test pyramid allocation, test type selection with cadence and priority, a non-functional test plan (load, stress, soak, spike, security, accessibility, compatibility), release validation phases (alpha/beta/UAT), automate-vs-manual guidance, CI gating policy, test data isolation rules, entry and exit criteria, closure metrics, and a residual risk statement.",
    inputSchema: {
      type: "object",
      properties: {
        projectContext: {
          type: "string",
          description:
            "What the system is, its stack, scale, and any compliance regime. E.g. \"multi-tenant SaaS billing dashboard, React + Node, 50k daily users, PCI DSS in scope\".",
        },
        riskProfile: {
          type: "string",
          enum: ["prototype", "standard", "regulated"],
          description:
            "Rigor tier. \"prototype\" trades depth for speed; \"regulated\" adds compliance gating. Defaults to \"standard\".",
        },
      },
      required: ["projectContext"],
    },
    handler: handleGenerateTestStrategy,
  },
];

const HANDLERS = Object.fromEntries(TOOLS.map((t) => [t.name, t.handler]));

/* ──────────────────────────────────────────────────────────────────────────
 * Server wiring
 * ────────────────────────────────────────────────────────────────────────── */

const server = new Server(
  { name: "qa-expert-engine", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params?.name;
  const handler = HANDLERS[toolName];

  if (!handler) {
    return toolError(`Unknown tool "${toolName}".`, {
      availableTools: TOOLS.map((t) => t.name),
    });
  }

  // Phase 2.7 — no handler fault can escape as an unhandled protocol error.
  try {
    return await handler(request.params.arguments);
  } catch (error) {
    if (error instanceof ToolInputError) {
      return toolError(`Invalid input for "${toolName}": ${error.message}`, error.details);
    }
    console.error(`[qa-expert-engine] ${toolName} failed:`, error);
    return toolError(
      `Tool "${toolName}" failed unexpectedly: ${error?.message ?? String(error)}`
    );
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is reserved for the JSON-RPC stream.
  console.error(
    `QA Expert MCP Server running via stdio. ${TOOLS.length} tools registered. Workspace: ${WORKSPACE_ROOT}`
  );
}

run().catch((error) => {
  console.error("[qa-expert-engine] fatal:", error);
  process.exit(1);
});
