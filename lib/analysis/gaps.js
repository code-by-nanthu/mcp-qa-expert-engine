/**
 * Requirement gap detection — the testability review that precedes test design
 * (Senior-QA-Engineer.md section 2, Requirement Analysis).
 *
 * Boundary Value Analysis is only as good as the stated boundary. Where the
 * input declares no bound, the generated cases fall back to platform limits,
 * which exercise the runtime rather than the business rule. That substitution
 * must be visible, or a reader mistakes a probe for a verified requirement.
 */

/** Platform limits substituted on each side of a missing bound. */
const LOWER_PROBES = "0, -1";
const UPPER_PROBES = "2147483647, 2^53, 2^53+1";

function numericGap(name, c) {
  const hasMin = typeof c.min === "number";
  const hasMax = typeof c.max === "number";
  if (hasMin && hasMax) return null;
  if (!hasMin && !hasMax) {
    return {
      gap: "no numeric range",
      probed: `${LOWER_PROBES}, ${UPPER_PROBES}`,
      ask: `What are the minimum and maximum values for ${name}?`,
    };
  }
  return hasMax
    ? { gap: "no minimum", probed: LOWER_PROBES, ask: `What is the lowest valid value for ${name}?` }
    : { gap: "no maximum", probed: UPPER_PROBES, ask: `What is the highest valid value for ${name}?` };
}

function lengthGap(name, c, noun, probed) {
  const max = c.maxLength ?? c.max;
  if (typeof max === "number") return null;
  return {
    gap: `no ${noun} limit`,
    probed,
    ask: `What is the maximum ${noun} of ${name}?`,
  };
}

/**
 * Returns one row per unbounded or unresolved parameter. An empty array means
 * every parameter carries a stated bound.
 */
function findRequirementGaps(parameters) {
  const gaps = [];

  for (const param of parameters) {
    const { name, type, constraints: c } = param;
    let found = null;

    switch (type) {
      case "number":
        found = numericGap(name, c);
        break;
      case "string":
        found = lengthGap(name, c, "length", "255 and 65536 characters");
        break;
      case "array":
        found = lengthGap(name, c, "size", "1000 elements");
        break;
      case "date":
        if (typeof c.min !== "number" && typeof c.max !== "number") {
          found = {
            gap: "no valid date range",
            probed: "epoch, leap day, 9999-12-31",
            ask: `What is the earliest and latest valid ${name}?`,
          };
        }
        break;
      case "unknown":
        found = {
          gap: "type could not be inferred",
          probed: "generic placeholders",
          ask: `What type is ${name}, and what values are valid?`,
        };
        break;
      default:
        // boolean and enum carry their full domain in the declaration itself.
        break;
    }

    if (found) {
      gaps.push({
        parameter: name,
        type,
        gap: found.gap,
        probed: found.probed,
        ask: found.ask,
      });
    }
  }

  return gaps;
}

/** Parameters whose nullability the input never states, one way or the other. */
function findUnstatedNullability(parameters) {
  return parameters.filter((p) => !p.constraints.required && !p.constraints.optional).map((p) => p.name);
}

export {
  findRequirementGaps,
  findUnstatedNullability,
};
