/**
 * Nine-attribute test case specification (Senior-QA-Engineer.md section 5).
 */

import { buildBvaVectors } from "./bva.js";

function buildTestCaseTitle(param, vector) {
  const expected = vector.expected.toLowerCase();
  if (expected.startsWith("reject")) return `Verify ${param.name} is rejected at ${vector.classification}`;
  if (expected.startsWith("accept")) return `Verify ${param.name} is accepted at ${vector.classification}`;
  if (expected.startsWith("apply")) return `Verify the documented default applies when ${param.name} is ${vector.classification}`;
  if (expected.startsWith("treat") || expected.startsWith("escape"))
    return `Verify ${param.name} is neutralised at ${vector.classification}`;
  if (expected.startsWith("define") || expected.startsWith("specify") || expected.startsWith("resolve"))
    return `Verify the documented behaviour of ${param.name} at ${vector.classification}`;
  return `Verify ${param.name} behaviour at ${vector.classification}`;
}


/** Renders one test case carrying all nine standard attributes. */
function renderTestCase(tc) {
  return [
    `${tc.id}  |  ${tc.module}  |  ${tc.title}`,
    `  Technique       : ${tc.technique}`,
    `  Pre-conditions  : ${tc.preConditions}`,
    `  Test Steps      : ${tc.steps}`,
    `  Test Data       : ${tc.testData}`,
    `  Expected Result : ${tc.expected}`,
    `  Actual Result   : ${tc.actual}   |   Status: ${tc.status}`,
  ].join("\n");
}


function buildTestCases(parameters, moduleInfo) {
  const cases = [];
  let counter = 1;

  for (const param of parameters) {
    const others = parameters.filter((p) => p.name !== param.name).map((p) => p.name);
    const otherLabel =
      others.length === 0
        ? "no other parameters are required"
        : `all other parameters (${others.slice(0, 5).join(", ")}${others.length > 5 ? ", …" : ""}) hold nominal valid values`;

    const invocation = moduleInfo.invocation ? `${moduleInfo.invocation}()` : moduleInfo.label;

    for (const vector of buildBvaVectors(param)) {
      cases.push({
        id: `TC_${moduleInfo.code}_${String(counter++).padStart(3, "0")}`,
        module: moduleInfo.label,
        title: buildTestCaseTitle(param, vector),
        technique: `Boundary Value Analysis — ${vector.classification}`,
        preConditions: `System under test is reachable and in a known-good state; ${invocation} is invocable; ${otherLabel}`,
        steps: `1. Set ${param.name} = ${vector.input}  2. Hold every other parameter at a nominal valid value  3. Invoke ${invocation}  4. Observe the returned value, rendered state, or raised error`,
        testData: `${param.name} = ${vector.input}`,
        expected: vector.expected,
        actual: "(pending execution)",
        status: "Not Run",
        parameter: param.name,
      });
    }
  }

  return cases;
}

export {
  renderTestCase,
  buildTestCases,
};
