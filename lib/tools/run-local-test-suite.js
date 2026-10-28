/**
 * Tool 2: sandboxed test execution. A failing suite is returned as a readable
 * result, never as a protocol fault.
 */

import { MAX_COMMAND_CHARS, WORKSPACE_ROOT } from "../config.js";
import { toolText, truncateLog } from "../format/result.js";
import { assertSafeCommand } from "../security/command.js";
import { classifyExecOutcome, runCommand } from "../security/exec.js";
import { validateArgs } from "../validation.js";

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

export {
  handleRunLocalTestSuite,
};
