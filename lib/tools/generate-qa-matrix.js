/**
 * Tool 1: black-box test design — BVA, EP, decision tables, state transitions
 * and exploratory charters, derived from code or requirements.
 */

import { findRequirementGaps, findUnstatedNullability } from "../analysis/gaps.js";
import { deriveModuleInfo, describeConstraints, extractConstraints, extractParameters, gatherContext, inferType, normalizeSource } from "../analysis/source.js";
import { buildEpBuckets } from "../design/bva.js";
import { MAX_DECISION_RULES, buildDecisionTable } from "../design/decision-table.js";
import { buildExploratoryCharters, renderCharter } from "../design/exploratory.js";
import { buildStateTransition } from "../design/state-transition.js";
import { buildTestCases, renderTestCase } from "../design/test-cases.js";
import { toolText } from "../format/result.js";
import { renderTable } from "../format/text.js";
import { validateArgs } from "../validation.js";

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

  // Testability review before test design: a boundary that was never stated
  // cannot be verified, only probed. Surfacing that first stops a platform
  // limit being read as a confirmed business rule.
  const gaps = findRequirementGaps(parameters);
  const unstatedNullability = findUnstatedNullability(parameters);

  sections.push("", "--- REQUIREMENTS GAPS ---");
  if (gaps.length === 0) {
    sections.push(
      "Every parameter carries a stated bound. The boundary values below are derived",
      "from the specification, not substituted."
    );
  } else {
    sections.push(
      `${gaps.length} of ${parameters.length} ${parameters.length === 1 ? "parameter has" : "parameters have"} no stated bound.`,
      "Those cases fall back to platform limits, which exercise the runtime rather",
      "than the business rule.",
      "Resolve these against the specification before treating the matrix as complete.",
      "",
      renderTable(
        ["Parameter", "Type", "Missing", "Probed instead with", "Ask the specification"],
        gaps.map((g) => [g.parameter, g.type, g.gap, g.probed, g.ask])
      )
    );
  }
  if (unstatedNullability.length) {
    sections.push(
      "",
      `Nullability is unstated for: ${unstatedNullability.join(", ")}.`,
      "Those cases assume the parameter is not nullable."
    );
  }

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
    `Unbounded parameters  : ${gaps.length}${gaps.length ? " — see REQUIREMENTS GAPS" : ""}`,
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

export {
  handleGenerateQaMatrix,
};
