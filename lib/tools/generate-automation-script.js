/**
 * generate-automation-script — see the tool it backs.
 */

import { buildFlowSteps, deriveFlowName } from "../analysis/flows.js";
import { FRAMEWORK_EMITTERS, SUPPORTED_FRAMEWORKS } from "../emitters/e2e.js";
import { emitAccessibility, emitBdd, emitDataDriven, emitResponsive, emitUiStates } from "../emitters/extensions.js";
import { toolText } from "../format/result.js";
import { kebabCase } from "../format/text.js";
import { validateArgs } from "../validation.js";

const COVERAGE_LEVELS = ["functional", "full"];


function handleGenerateAutomationScript(args) {
  const { framework, flowDescription, coverage } = validateArgs(args, {
    framework: { required: true, enum: SUPPORTED_FRAMEWORKS, maxLength: 32 },
    flowDescription: { required: true, maxLength: 4000 },
    coverage: { required: false, enum: COVERAGE_LEVELS, default: "full", maxLength: 32 },
  });

  const flowName = deriveFlowName(flowDescription);
  const steps = buildFlowSteps(flowDescription);
  const fileSlug = kebabCase(flowName);
  const emit = FRAMEWORK_EMITTERS[framework];

  const emitted = ["Page Object Model + functional spec"];
  const blocks = [emit(flowName, steps, flowDescription)];

  if (coverage === "full") {
    blocks.push(
      emitDataDriven(framework, flowName, steps, fileSlug),
      emitResponsive(framework, flowName, steps, fileSlug),
      emitUiStates(framework, flowName, steps, fileSlug),
      emitAccessibility(framework, flowName, fileSlug),
      emitBdd(flowName, steps, flowDescription, fileSlug)
    );
    emitted.push(
      "data-driven spec",
      "responsive + visual regression spec",
      "component state spec",
      "accessibility spec",
      "BDD feature file"
    );
  }

  const header = [
    `// Framework : ${framework}`,
    `// Flow      : ${flowDescription}`,
    `// Steps     : ${steps.length} derived`,
    `// Coverage  : ${coverage} — ${emitted.join(", ")}`,
    "// Selectors : data-testid based — align these with the application markup.",
    "// Waits     : explicit condition-based only; no fixed sleeps.",
    coverage === "functional"
      ? '// NOTE      : coverage "full" additionally emits data-driven, responsive/VRT,\n//             component-state, accessibility, and BDD artifacts.'
      : "",
    "",
  ]
    .filter(Boolean)
    .join("\n") + "\n\n";

  // PRD section 4 is explicit: Tool 4 returns plain text, not JSON.
  return toolText(header + blocks.join("\n"));
}

export {
  handleGenerateAutomationScript,
};
