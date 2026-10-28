/**
 * The one error type that signals a caller mistake rather than a server fault.
 */

class ToolInputError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ToolInputError";
    this.details = details;
  }
}

export {
  ToolInputError,
};
