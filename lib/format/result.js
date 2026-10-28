/**
 * MCP tool-result envelopes. Tool failures return isError, never a protocol fault.
 */

import { LOG_HEAD_LINES, LOG_TAIL_LINES } from "../config.js";

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

export {
  toolText,
  toolJson,
  toolError,
  truncateLog,
};
