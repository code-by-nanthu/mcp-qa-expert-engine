/**
 * Hand-rolled argument validation. The MCP SDK does not enforce inputSchema at runtime.
 */

import { MAX_INPUT_CHARS } from "./config.js";
import { ToolInputError } from "./errors.js";

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

export {
  validateArgs,
};
