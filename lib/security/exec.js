/**
 * Subprocess execution. execFile with shell:false; stdio piped, never inherited.
 */

import { execFile } from "node:child_process";
import { EXEC_MAX_BUFFER, EXEC_TIMEOUT_MS, WORKSPACE_ROOT } from "../config.js";

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

export {
  runCommand,
  classifyExecOutcome,
};
