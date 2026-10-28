/**
 * Tool 8: STLC strategy — context analysis, pyramid allocation, type selection,
 * non-functional plan, release gates, exit criteria and closure metrics.
 */

import { AUTOMATE_GUIDANCE, COMPLIANCE_SIGNALS, CORE_PRINCIPLES, DOMAIN_SIGNALS, NON_FUNCTIONAL_PLAN, PYRAMID, RELEASE_VALIDATION, RISK_PROFILES } from "../catalog/strategy.js";
import { toolText } from "../format/result.js";
import { renderTable } from "../format/text.js";
import { validateArgs } from "../validation.js";

function detectDomain(context) {
  const matches = DOMAIN_SIGNALS.filter((s) => s.re.test(context));
  return matches.length ? matches : [{ domain: "general application", critical: "Correctness of the primary user journeys and data integrity." }];
}


function detectCompliance(context) {
  return COMPLIANCE_SIGNALS.filter((s) => s.re.test(context));
}


function detectScale(context) {
  const users = context.match(/([\d,.]+)\s*(k|m|million|thousand)?\s*(?:daily |monthly |concurrent )?(?:active )?users/i);
  const rps = context.match(/([\d,.]+)\s*(?:rps|req\/s|requests per second|tps)/i);
  const notes = [];
  if (users) notes.push(`user volume: ${users[0]}`);
  if (rps) notes.push(`throughput: ${rps[0]}`);
  return notes.length ? notes.join("; ") : "not stated — establish the expected peak before load testing";
}


function handleGenerateTestStrategy(args) {
  const { projectContext, riskProfile } = validateArgs(args, {
    projectContext: { required: true, preserveWhitespace: true },
    riskProfile: { required: false, enum: RISK_PROFILES, default: "standard", maxLength: 32 },
  });

  const domains = detectDomain(projectContext);
  const compliance = detectCompliance(projectContext);
  const scale = detectScale(projectContext);
  const isRegulated = riskProfile === "regulated" || compliance.length > 0;
  const isPrototype = riskProfile === "prototype";

  const sections = [
    "=== TEST STRATEGY & PLAN ===",
    `[Risk Profile]   ${riskProfile}${compliance.length && riskProfile !== "regulated" ? " (compliance signals detected — consider \"regulated\")" : ""}`,
    `[Domain]         ${domains.map((d) => d.domain).join(", ")}`,
    `[Scale]          ${scale}`,
    `[Compliance]     ${compliance.length ? compliance.map((c) => c.label).join(", ") : "none detected"}`,
    "",
    "--- CONTEXT-CRITICAL CONCERNS ---",
    "Testing is context-dependent. These are the concerns this domain fails on:",
    "",
    ...domains.map((d) => `  - ${d.domain}: ${d.critical}`),
  ];

  if (compliance.length) {
    sections.push(
      "",
      "--- COMPLIANCE OBLIGATIONS ---",
      renderTable(["Regime", "Testing Demand"], compliance.map((c) => [c.label, c.demand]))
    );
  }

  sections.push(
    "",
    "--- CORE PRINCIPLES APPLIED TO THIS PROJECT ---",
    ...CORE_PRINCIPLES.map((p) => `  ${p.name}\n    -> ${p.apply}`)
  );

  sections.push(
    "",
    "--- TEST PYRAMID ALLOCATION ---",
    "Distribute the automated portfolio for velocity and low maintenance.",
    "",
    renderTable(
      ["Tier", "Share", "Scope", "Budget", "Owner", "Tooling"],
      PYRAMID.map((t) => [t.tier, t.share, t.scope, t.speed, t.owner, t.tool])
    ),
    "",
    "An inverted pyramid (UI-heavy) is the single most common cause of a slow, flaky",
    "suite. If E2E exceeds 10%, push those assertions down a tier."
  );

  sections.push(
    "",
    "--- STLC PHASE PLAN ---",
    renderTable(
      ["Phase", "Activity", "Output", "Tool"],
      [
        ["1. Requirement Analysis", "Identify testable requirements and ambiguities", "Clarification list, testability review", "generate_qa_matrix"],
        ["2. Test Planning", "Scope, risk, resource, and schedule", "This document", "generate_test_strategy"],
        ["3. Test Design", "Derive cases from requirements", "BVA/EP matrix, decision tables, charters", "generate_qa_matrix, generate_manual_test_plan"],
        ["4. Environment Setup", "Provision data, fixtures, and config", "Reproducible environment", "generate_manual_test_plan (Phase A)"],
        ["5. Execution", "Run scripted and exploratory passes", "Results, defect records", "run_local_test_suite, parse_error_logs"],
        ["6. Cycle Closure", "Evaluate exit criteria and metrics", "Test Summary Report", "metrics section below"],
      ]
    )
  );

  const typeRows = [
    ["Unit", "Every commit", isPrototype ? "Medium" : "Critical", "Fastest feedback; carries 70% of coverage"],
    ["Integration / API", "Every commit", "Critical", "Where contract defects actually surface"],
    ["E2E UI", "Every merge to main", "High", "Critical journeys only"],
    ["Smoke", "Every deployment", "Critical", "Build verification before deeper testing"],
    ["Sanity", "After each bug fix", "High", "Narrow confirmation of the fix"],
    ["Regression", "Every release", "Critical", "Guards previously working behaviour"],
    ["Visual Regression", "Every UI change", isPrototype ? "Low" : "Medium", "Catches unintended layout drift"],
    ["Accessibility", "Every UI change", isRegulated ? "Critical" : "High", "Legal exposure and real user impact"],
    ["Compatibility", "Every UI change", "High", "Blink, WebKit, Gecko plus supported viewports"],
    ["Performance (Load)", "Every release touching a request path", isPrototype ? "Low" : "High", "Protects the latency budget"],
    ["Security / Pentest", "Annually and on auth changes", isRegulated ? "Critical" : "High", "Authorisation bypass is the costliest class"],
    ["UAT", "Before release", isPrototype ? "Low" : "Critical", "Guards against the absence-of-errors fallacy"],
  ];

  sections.push(
    "",
    "--- TEST TYPE SELECTION ---",
    renderTable(["Type", "Cadence", "Priority", "Rationale"], typeRows)
  );

  sections.push(
    "",
    "--- NON-FUNCTIONAL TEST PLAN ---",
    renderTable(
      ["Type", "Objective", "Trigger", "Exit Criterion"],
      NON_FUNCTIONAL_PLAN.map((n) => [n.type, n.objective, n.trigger, n.exit])
    )
  );

  sections.push(
    "",
    "--- VISIBILITY COVERAGE ---",
    "  Black-box : Requirement-driven cases from generate_qa_matrix. Primary technique.",
    "  White-box : Developer-owned. Target branch and statement coverage on business logic;",
    "              coverage percentage is a smoke alarm, not a goal.",
    "  Grey-box  : QA with database and log access — verify the persisted state after each",
    "              UI action, not just the rendered confirmation."
  );

  sections.push(
    "",
    "--- RELEASE VALIDATION ---",
    renderTable(
      ["Phase", "Participants", "Goal", "Exit Gate"],
      RELEASE_VALIDATION.map((r) => [r.phase, r.who, r.goal, r.gate])
    )
  );

  sections.push(
    "",
    "--- AUTOMATE vs TEST MANUALLY ---",
    "",
    "Automate:",
    ...AUTOMATE_GUIDANCE.automate.map((a) => `  [+] ${a}`),
    "",
    "Do not automate:",
    ...AUTOMATE_GUIDANCE.doNotAutomate.map((a) => `  [-] ${a}`)
  );

  sections.push(
    "",
    "--- CI/CD GATING POLICY ---",
    "  [ ] Unit and integration suites run on every pull request.",
    "  [ ] A single failing test blocks the merge. No exceptions, no re-run-until-green.",
    "  [ ] Smoke suite gates every deployment; failure triggers automatic rollback.",
    "  [ ] E2E runs on merge to main, sharded for wall-clock, not skipped for speed.",
    "  [ ] Flaky tests are quarantined with an owner and a deadline, never silently retried.",
    `  [ ] Coverage must not decrease${isRegulated ? "; regulated code paths require an explicit threshold." : "."}`,
    "  [ ] Accessibility and visual regression run on any UI diff."
  );

  sections.push(
    "",
    "--- TEST DATA ISOLATION ---",
    "  [ ] Each run seeds its own data; no two runs share a mutable record.",
    "  [ ] Transactional fixtures roll back, or each worker gets a dedicated schema.",
    "  [ ] No test depends on another test having run first.",
    "  [ ] External services are mocked or contract-tested, never called live in CI.",
    compliance.some((c) => c.label !== "WCAG / Section 508")
      ? "  [ ] Production data is never copied into a test environment unmasked."
      : "  [ ] Production-like data volumes used for performance runs."
  );

  const entry = [
    "Requirements reviewed and testable; ambiguities resolved.",
    "Build deployed to the test environment and smoke-verified.",
    "Test data and fixtures seeded.",
    "Test cases designed and peer-reviewed.",
  ];
  const exit = [
    "All planned cases executed; none left Not Run.",
    isPrototype ? "No Critical defects open." : "No Critical or High defects open.",
    "Every failure has a defect record with full reproduction evidence.",
    "Regression suite green on the release candidate.",
    "Non-functional exit criteria met for every triggered type.",
    "Test Summary Report published with metrics below.",
    isRegulated ? "Compliance evidence archived and signed off." : "Known limitations accepted by the product owner.",
  ];

  sections.push(
    "",
    "--- ENTRY CRITERIA ---",
    ...entry.map((c) => `  [ ] ${c}`),
    "",
    "--- EXIT CRITERIA ---",
    ...exit.map((c) => `  [ ] ${c}`)
  );

  sections.push(
    "",
    "--- CLOSURE METRICS ---",
    renderTable(
      ["Metric", "Formula", "Signal"],
      [
        ["Pass rate", "passed / executed", "Below 95% means the build was not ready"],
        ["Defect density", "defects / KLOC or story point", "Rising density concentrates next cycle's effort"],
        ["Defect clustering", "defects grouped by module", "The top module gets deeper testing next cycle"],
        ["Defect escape rate", "production defects / total found", "The honest measure of suite effectiveness"],
        ["Mean time to detect", "commit timestamp to failure timestamp", "Rising means feedback loops are degrading"],
        ["Automation coverage", "automated cases / total cases", "Track the trend, never the absolute number"],
        ["Flake rate", "non-deterministic runs / total runs", "Above 1% erodes trust in the whole suite"],
      ]
    )
  );

  sections.push(
    "",
    "--- RESIDUAL RISK ---",
    "Exhaustive testing is impossible. State plainly what this strategy does NOT cover:",
    "  - Input combinations beyond the selected boundary and partition representatives.",
    "  - Browser, device, and OS versions outside the supported matrix.",
    "  - Third-party outages and their cascading effects.",
    "  - Load patterns that differ in shape from the modelled peak.",
    isPrototype
      ? "  - At prototype risk tier, depth is deliberately traded for speed. Revisit before launch."
      : "  - Emergent behaviour under sustained real-world concurrency."
  );

  return toolText(sections.join("\n"));
}

export {
  handleGenerateTestStrategy,
};
