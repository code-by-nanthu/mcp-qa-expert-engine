/**
 * Operational limits and the workspace root. Imported everywhere; imports nothing.
 */

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

export {
  MAX_INPUT_CHARS,
  MAX_COMMAND_CHARS,
  EXEC_TIMEOUT_MS,
  EXEC_MAX_BUFFER,
  LOG_HEAD_LINES,
  LOG_TAIL_LINES,
  MAX_PARAMETERS,
  MAX_FLOW_STEPS,
  WORKSPACE_ROOT,
};
