### Product Requirement Document (PRD)

### Project Name: Universal QA Expert Engine MCP Skill

**Version:** 1.1.0
**Target Environments:** Anthropic Claude Code, Antigravity, Cursor, VS Code, Codex
**Protocol Specification:** Model Context Protocol (MCP) v1.0.0

### 1. Executive Summary & Objective

### What We Are Building

We are building a highly portable, platform-agnostic AI agent tool (a custom "skill") powered by Anthropic's Model Context Protocol (MCP). The purpose of this tool is to instantly upgrade standard LLM coding agents into a Senior QA Automation and Manual Testing Engineer with 10+ years of domain expertise.

### Why It Matters

Standard LLM tools can check code logic but fail to plan tests dynamically according to strict black-box methodologies, catch boundary bugs, or test system contracts. This skill provides a bridge by exposing local environment terminal checks, automated code metrics, and structured edge-case test planning directly to the AI's agentic reasoning loop.

### 2. Core Architecture & Stack

* **Runtime:** Node.js (ES Modules, "type": "module")
* **Core Dependency:** @modelcontextprotocol/sdk (v1.0.0+)
* **Transport Mechanism:** Standard Input/Output (stdio) JSON-RPC 2.0 communication.
* **Distribution Channel:** Public npm registry (mcp-qa-expert-engine) and GitHub open-source code base.
* **Deployment Engine:** GitHub Actions (publish.yml) triggered securely via non-interactive NPM_TOKEN injection.

### 3. Implemented Features (What is Built)

> **Revision note (v1.0.1):** Section 3 previously described the shebang and Tool 1 as
> complete. A verification audit found the shebang absent and Tool 1 functioning as a
> static template. Both were corrected in v1.0.1.
>
> **Revision note (v1.1.0):** A cross-check against the QA reference manuals in
> `docs/supporting/` found the v1.0 scope covered roughly a fifth of the described
> discipline — no manual-testing output, no UI/UX auditing, no API contract layer, and
> no STLC planning. Four tools were added and three existing tools extended to close
> those gaps. See section 7.

All eight tools are implemented, registered, and verified by an automated smoke suite
(`npm test`, 105 checks) that drives a live stdio JSON-RPC session.

**Infrastructure**

* **Executable Entrypoint (index.js):** Contains the `#!/usr/bin/env node` shebang and is mode 0755. Verified by installing the packed tarball and invoking the resulting `node_modules/.bin` binary.
* **Protocol Handlers:** `ListToolsRequestSchema` and `CallToolRequestSchema` are registered against a single tool registry and a name-keyed dispatch table.
* **Shared Safety Layer:** Hand-rolled, zero-dependency argument validation; workspace boundary enforcement with symlink resolution; a test-command sanitizer; and a top-level handler guard that converts any fault into an `isError` tool result rather than a JSON-RPC protocol error.

**Tools**

* **Tool 1 (generate_qa_matrix):** Parses function signatures (JS/TS/Python), TypeScript interfaces, git diffs, and markdown requirement bullets. Extracts parameters, infers types, mines declared constraints, and emits a parameter inventory, an identified Boundary Value Analysis matrix, Equivalence Partitioning buckets, and a coverage summary. Output is derived from the input, not templated.
* **Tool 2 (run_local_test_suite):** Executes vetted commands via `execFile` with `shell: false` and a tokenized argv array. Captures stdout, stderr, exit code, and duration into the tool result; subprocess stdio is never inherited. Bounded at 300s and a 10MB buffer.
* **Tool 3 (parse_error_logs):** Produces structured JSON defect records from Node, browser, Python, Java, and Jest/Vitest failure output, with deterministic defect ids and graceful degradation on unrecognised input.
* **Tool 4 (generate_automation_script):** Emits Page Object Model scaffolding for Playwright, Cypress, and Jest, derived from a plain-language flow description. Returns plain text per section 4.

**Deployment**

* **GitHub Actions (publish.yml):** Publishes on release via non-interactive `NPM_TOKEN` injection against `https://registry.npmjs.org`, gated on the smoke suite passing.

### 4. Tool Specifications (Delivered in v1.0.1)

The three tools below were specified as the remaining roadmap in v1.0.0 and are now implemented in index.js. The specifications are retained as the authoritative contract for each tool.

### Tool 2: run_local_test_suite

* **Objective:** Allows the AI agent to execute local testing suites directly inside the user's terminal workspace environment and securely interpret the log stream back.
* **Input Parameters:**

  * command (string, e.g., "npm test", "pytest", "npm run test:coverage").
* **Execution Mechanism:** Node.js child_process execution block.
  * **Implementation deviation (approved):** delivered with `execFile` and a tokenized argv array (`shell: false`) rather than `exec`. `exec` spawns a shell, which is the very surface the safety boundary below exists to close; `execFile` removes it structurally instead of relying on filtering alone.
* **Safety Boundary:** Absolute validation sanitization to stop execution chains if risky terminal commands (e.g., ; rm -rf) are appended. Delivered as defense-in-depth on top of the shell-free execution path: metacharacter rejection, a runner allowlist, destructive-token scanning, and workspace-boundary confinement of path arguments.

### Tool 3: parse_error_logs

* **Objective:** Ingests unformatted, raw terminal crashes, network browser payloads, or stack traces from visual failures to output clean, structured, standardized defect bug records.
* **Input Parameters:**

  * rawLogs (string, mandatory raw error trace text content).
* **Expected Return Model:** A JSON payload containing explicit steps to reproduce, impacted code segments, error classes, and suggested fix vectors.

### Tool 4: generate_automation_script

* **Objective:** Dynamically formats production-ready browser automation layout patterns based on target selectors.
* **Input Parameters:**

  * framework (enum: "playwright", "cypress", "jest").
  * flowDescription (string, e.g., "user logs in, visits the billing card screen, adds a valid credit card layout").
* **Expected Return Model:** A clean, plain-text string containing the complete Page Object Model formatted testing script block.

### 5. Non-Functional Requirements & Best Practices

* **Deterministic Standard Output:** All debugging, system notices, and non-essential boot tracking metrics must be explicitly sent via console.error(). The main console.log() channel must remain exclusively reserved for protocol JSON messages to prevent system crashes across agent parsers.
* **Stateless Tool Boundaries:** No localized variables should maintain app state over continuous command runs. Every single call to a tool from the agent should process independently.
* **Security Protocols:** Path manipulation parameters must be rigidly bound inside the target project workspace boundaries. The agent must never be permitted to reach parent directory structures (../../).

### 6. Success Metrics & Verification Flow

A feature release is classified as structurally stable when:

1. The workspace compiles cleanly with no type definitions missing.
2. The script can boot silently over raw terminal execution: node index.js.
3. The package cleanly maps via npx -y mcp-qa-expert-engine across active local instances of Anthropic Claude Code, Cursor, and Antigravity.

---

### 7. Version 1.1.0 — QA Discipline Coverage

The reference manuals in `docs/supporting/` (Senior-QA-Engineer, Testing-Types,
Manual-Testing, UI-Testing) describe the full remit of a Senior QA Engineer. v1.0
implemented the PRD faithfully but covered only part of that remit. v1.1 closes the gap.

### Tools Added

* **Tool 5: generate_ui_ux_checklist** — Lead UI/UX Auditor. Responsive viewport matrix at the documented breakpoints, cross-browser engine matrix (Blink/WebKit/Gecko), visual regression targets, nine interactive component states, WCAG 2.1 AA criteria, UX usability metrics with the observation protocol, and risk-ranked flows for manual verification. Closes UI-Testing.md, previously at 0% coverage.
* **Tool 6: generate_manual_test_plan** — The human-tester counterpart to Tool 1. Environment setup, happy-path/negative/boundary/contextual passes, exploratory charters, a complete defect report template, STLC exit criteria, and closure metrics. Closes Manual-Testing.md.
* **Tool 7: generate_api_contract_tests** — The component/API tier of the testing pyramid. Status-code contracts per verb, payload validation, schema and content-type assertions, error-envelope hygiene, and a universal contract checklist across supertest, Playwright, and pytest. Delivers the "test system contracts" claim made in section 1.
* **Tool 8: generate_test_strategy** — STLC planning and closure. Context and compliance detection, the seven core principles applied to the detected domain, 70/20/10 pyramid allocation, test type selection, non-functional planning (load/stress/soak/spike/security/a11y/compatibility), alpha/beta/UAT gates, CI policy, entry and exit criteria, closure metrics, and a residual risk statement.

### Tools Extended

* **Tool 1 (generate_qa_matrix)** — Test cases now carry all nine standard attributes rather than five. Decision Table and State Transition techniques added, completing the black-box set. Exploratory charters emitted alongside the scripted cases. Type inference strengthened so declared types, quoted unions, and constraint-implied shapes all resolve.
* **Tool 3 (parse_error_logs)** — Defect records gained environment specs extracted from the log (with missing fields named rather than silently omitted), pre-conditions, component, reproducibility, status, and a category-appropriate evidence list. A `format` parameter renders the record as ready-to-paste Jira wiki markup.
* **Tool 4 (generate_automation_script)** — A `coverage` parameter adds data-driven specs, responsive and visual regression specs with cross-browser project config, component state specs, accessibility specs wired to axe, and a BDD `.feature` file, completing the automation pattern set.

### Deliberately Out of Scope

Execution of non-functional testing (load generation, pixel diffing, a11y scanning)
requires a browser, a baseline store, and a load harness. This server generates the
tests, checklists, and plans for that work; it does not attempt to be the runner.
