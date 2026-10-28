/**
 * Tool 6: a human-executable test plan — setup, happy/negative/boundary passes,
 * contextual edge cases, charters, defect template and exit criteria.
 */

import { extractUserFlows } from "../analysis/flows.js";
import { deriveFeatureName, deriveModuleInfo, extractConstraints, extractParameters, gatherContext, inferType, normalizeSource } from "../analysis/source.js";
import { CONTEXTUAL_EDGE_CASES, ENVIRONMENT_SETUP, EXIT_CRITERIA } from "../catalog/manual.js";
import { buildExploratoryCharters, renderCharter } from "../design/exploratory.js";
import { toolText } from "../format/result.js";
import { validateArgs } from "../validation.js";

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

export {
  handleGenerateManualTestPlan,
};
