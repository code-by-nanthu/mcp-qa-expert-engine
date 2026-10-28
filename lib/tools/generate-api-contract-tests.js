/**
 * Tool 7: component/API contract tests — status codes per verb, payload and
 * schema assertions, and error-envelope hygiene.
 */

import { deriveFeatureName, extractConstraints, extractParameters, gatherContext, inferType, normalizeSource } from "../analysis/source.js";
import { API_FRAMEWORKS, STATUS_CONTRACT, UNIVERSAL_CONTRACTS } from "../catalog/api.js";
import { API_EMITTERS, parseEndpoints } from "../emitters/api.js";
import { toolText } from "../format/result.js";
import { validateArgs } from "../validation.js";

function handleGenerateApiContractTests(args) {
  const { apiSpec, framework } = validateArgs(args, {
    apiSpec: { required: true, preserveWhitespace: true },
    framework: { required: false, enum: API_FRAMEWORKS, default: "supertest", maxLength: 32 },
  });

  const { source } = normalizeSource(apiSpec);
  const endpoints = parseEndpoints(source);
  const discovered = extractParameters(source);
  const parameters = discovered.map((p) => {
    const context = gatherContext(source, p.name);
    const constraints = extractConstraints(context, p.rawType);
    return { ...p, constraints, type: inferType(p.name, p.rawType, constraints) };
  });

  const specName = deriveFeatureName(apiSpec);

  if (endpoints.length === 0) {
    return toolText(
      [
        "=== API CONTRACT TESTS ===",
        "",
        "No endpoints could be extracted from this specification.",
        "",
        "Supply one of the following:",
        "  - REST routes in the form: POST /api/v1/orders",
        "  - an OpenAPI path block",
        "  - GraphQL operations in the form: mutation createOrder",
        "",
        "--- UNIVERSAL CONTRACT CHECKLIST (applies to every endpoint) ---",
        ...UNIVERSAL_CONTRACTS.map((c) => `  [ ] ${c}`),
      ].join("\n")
    );
  }

  const emit = API_EMITTERS[framework];
  const totalCases = endpoints.reduce(
    (sum, e) => sum + (STATUS_CONTRACT[e.method] ?? STATUS_CONTRACT.GET).length + 2,
    0
  );

  const c = framework === "pytest" ? "#" : "//";
  const header = [
    `${c} Framework : ${framework}`,
    `${c} Spec      : ${specName}`,
    `${c} Endpoints : ${endpoints.length} detected — ${endpoints.map((e) => `${e.method} ${e.path}`).join(", ")}`,
    `${c} Fields    : ${parameters.length} detected`,
    `${c} Cases     : ~${totalCases} generated`,
    "",
  ].join("\n");

  const checklist = [
    "",
    framework === "pytest" ? "# --- UNIVERSAL CONTRACT CHECKLIST ---" : "// --- UNIVERSAL CONTRACT CHECKLIST ---",
    ...UNIVERSAL_CONTRACTS.map((c) => (framework === "pytest" ? `#   [ ] ${c}` : `//   [ ] ${c}`)),
  ].join("\n");

  return toolText(header + emit(endpoints, parameters, specName) + checklist);
}

export {
  handleGenerateApiContractTests,
};
