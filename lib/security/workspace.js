/**
 * Workspace boundary enforcement, including symlink escape (PRD section 5).
 */

import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT } from "../config.js";
import { ToolInputError } from "../errors.js";

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

export {
  assertWithinWorkspace,
};
