/**
 * Domain signals, compliance regimes, principles, pyramid, and non-functional plan.
 */

const RISK_PROFILES = ["prototype", "standard", "regulated"];


const DOMAIN_SIGNALS = [
  { re: /e-?commerce|checkout|cart|storefront|retail|marketplace/i, domain: "e-commerce", critical: "Payment accuracy, inventory consistency, and cart integrity under concurrency." },
  { re: /fintech|bank|payment|ledger|trading|invoice|billing|payroll/i, domain: "financial", critical: "Monetary correctness to the smallest unit, auditability, and idempotent transactions." },
  { re: /health|patient|clinical|medical|ehr|hipaa/i, domain: "healthcare", critical: "Patient data confidentiality, clinical accuracy, and full audit trails." },
  { re: /\bsaas\b|dashboard|tenant|subscription|workspace/i, domain: "multi-tenant SaaS", critical: "Tenant isolation — no query may ever cross a tenant boundary." },
  { re: /mobile|ios|android|react native|flutter/i, domain: "mobile", critical: "Device and OS fragmentation, offline behaviour, and background/foreground transitions." },
  { re: /\bapi\b|microservice|backend|grpc|graphql/i, domain: "service/API", critical: "Contract stability, backward compatibility, and graceful degradation." },
  { re: /\biot\b|device|firmware|embedded|sensor/i, domain: "IoT/embedded", critical: "Intermittent connectivity, constrained resources, and over-the-air update safety." },
  { re: /\bml\b|machine learning|\bai\b|model|inference|llm/i, domain: "ML/AI", critical: "Non-determinism, drift detection, and bounded output validation." },
];


const COMPLIANCE_SIGNALS = [
  { re: /\bpci\b|card data|cardholder/i, label: "PCI DSS", demand: "No PAN in logs; segmented cardholder data environment; quarterly scans." },
  { re: /\bhipaa\b|\bphi\b/i, label: "HIPAA", demand: "PHI encrypted at rest and in transit; access audit log; signed BAAs." },
  { re: /\bgdpr\b|right to be forgotten|data subject/i, label: "GDPR", demand: "Erasure and export verified end to end; lawful-basis records; consent withdrawal." },
  { re: /\bsox\b|financial report/i, label: "SOX", demand: "Change control evidence; segregation of duties; immutable audit trail." },
  { re: /\bwcag\b|accessib|a11y|section 508/i, label: "WCAG / Section 508", demand: "AA conformance verified by audit, not only automated scanning." },
];


const CORE_PRINCIPLES = [
  { name: "Testing shows the presence of defects, not their absence", apply: "Report residual risk alongside pass rate. A green suite is evidence, not proof." },
  { name: "Exhaustive testing is impossible", apply: "Allocate effort by risk. The highest-risk flows below get depth; the rest get breadth." },
  { name: "Early testing (shift-left)", apply: "Run generate_qa_matrix against the specification before implementation starts." },
  { name: "Defect clustering (Pareto)", apply: "Track defects per module. When one module produces the most, test it harder next cycle." },
  { name: "The pesticide paradox", apply: "Rotate and extend the suite each cycle; add the exploratory charters that automation cannot replace." },
  { name: "Testing is context-dependent", apply: "This strategy is tailored to the domain and risk tier detected below — do not reuse it verbatim elsewhere." },
  { name: "Absence-of-errors fallacy", apply: "Validate against user need, not only the specification. UAT is the gate that catches this." },
];


const PYRAMID = [
  { tier: "Unit", share: "70%", scope: "Single functions, hooks, reducers, pure logic. All dependencies mocked.", speed: "< 10ms each", owner: "Developer", tool: "Jest / Vitest / pytest" },
  { tier: "Integration / API", share: "20%", scope: "Contracts between modules, services, and the database. Real I/O, no UI.", speed: "< 1s each", owner: "Developer + QA", tool: "supertest / Playwright API / pytest" },
  { tier: "End-to-End UI", share: "10%", scope: "Critical user journeys through the full stack.", speed: "< 60s each", owner: "QA", tool: "Playwright / Cypress" },
];


const NON_FUNCTIONAL_PLAN = [
  { type: "Load", objective: "Behaviour at expected peak traffic", trigger: "Every release touching a request path", exit: "p95 latency within budget; error rate < 0.1%" },
  { type: "Stress", objective: "Find the breaking point and the failure mode", trigger: "Quarterly, and before a major launch", exit: "Degrades gracefully; recovers without manual intervention" },
  { type: "Endurance (Soak)", objective: "Memory leaks and resource exhaustion over 24-72h", trigger: "Before each major release", exit: "Flat memory profile; no connection pool growth" },
  { type: "Spike", objective: "Reaction to a sudden traffic surge", trigger: "Before any campaign or launch event", exit: "Autoscaling engages; no cascading failure; queue drains" },
  { type: "Security / Pentest", objective: "Authentication, authorisation, and injection vulnerabilities", trigger: "Annually and on any auth change", exit: "No High or Critical findings open" },
  { type: "Accessibility", objective: "WCAG 2.1 AA conformance", trigger: "Every UI change", exit: "Zero automated violations; manual keyboard and screen-reader pass" },
  { type: "Compatibility", objective: "Consistent rendering across engines and viewports", trigger: "Every UI change", exit: "Blink, WebKit, and Gecko all pass at every supported breakpoint" },
];


const RELEASE_VALIDATION = [
  { phase: "Alpha", who: "Internal developers and QA", goal: "Catch critical defects before external exposure", gate: "No Critical defects open; smoke suite green" },
  { phase: "Beta", who: "Selected real-world users", goal: "Usability feedback and environment-diversity defects", gate: "Feedback triaged; no Critical regressions reported" },
  { phase: "UAT", who: "Client or business owner", goal: "Confirm the delivered business value", gate: "Formal sign-off against acceptance criteria" },
];


const AUTOMATE_GUIDANCE = {
  automate: [
    "Stable regression suites that run every commit.",
    "Deterministic boundary and equivalence cases from generate_qa_matrix.",
    "API contract tests — cheap, fast, and the highest value per line.",
    "Smoke suite gating every deployment.",
    "Accessibility scanning and visual regression baselines.",
  ],
  doNotAutomate: [
    "Exploratory testing — the value is in the human adapting mid-session.",
    "Usability and emotional friction — automation cannot measure frustration.",
    "Visual polish judgement beyond pixel diffing.",
    "Features whose requirements are still changing weekly — the suite will cost more than it saves.",
    "One-off data migrations verified once and never repeated.",
  ],
};

export {
  RISK_PROFILES,
  DOMAIN_SIGNALS,
  COMPLIANCE_SIGNALS,
  CORE_PRINCIPLES,
  PYRAMID,
  NON_FUNCTIONAL_PLAN,
  RELEASE_VALIDATION,
  AUTOMATE_GUIDANCE,
};
