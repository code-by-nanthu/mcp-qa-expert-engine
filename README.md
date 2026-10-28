# Universal QA Expert Engine MCP Skill

An automated Model Context Protocol (MCP) server that turns AI coding agents (Claude Code, Cursor, Antigravity, Codex, VS Code) into a Senior QA Automation and Manual Test Engineer.

Eight tools covering black-box test design, manual and exploratory testing, UI/UX auditing, API contract testing, automation scaffolding, test execution, defect triage, and STLC strategy.

## Quick Installation

```json
{
  "mcpServers": {
    "qa-expert": {
      "command": "npx",
      "args": ["-y", "mcp-qa-expert-engine"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| [`generate_qa_matrix`](#generate_qa_matrix) | Black-box test design: BVA, EP, decision tables, state transitions, exploratory charters |
| [`generate_manual_test_plan`](#generate_manual_test_plan) | Human-executable checklist, edge cases, defect template, exit criteria |
| [`generate_ui_ux_checklist`](#generate_ui_ux_checklist) | Responsive, cross-browser, VRT, component states, WCAG, UX metrics, risk-ranked flows |
| [`generate_automation_script`](#generate_automation_script) | Page Object Model plus data-driven, responsive, state, a11y, and BDD artifacts |
| [`generate_api_contract_tests`](#generate_api_contract_tests) | Status-code contracts, payload validation, schema and error-envelope assertions |
| [`generate_test_strategy`](#generate_test_strategy) | STLC plan, test pyramid, type selection, non-functional plan, closure metrics |
| [`run_local_test_suite`](#run_local_test_suite) | Sandboxed test execution with injection-proof command handling |
| [`parse_error_logs`](#parse_error_logs) | Structured defect records and Jira-ready bug reports from raw traces |

---

### `generate_qa_matrix`

**`codeSnippet`** (string, required)

Parses function signatures (JS/TS/Python), TypeScript interfaces, git diffs, and markdown requirement bullets. Extracts parameters, infers types, and mines declared constraints. Emits:

- **Parameter inventory** with inferred types and detected constraints
- **Test case specification** carrying all nine standard attributes — ID (`TC_<MODULE>_001`), Component/Module, action-verb Title, Pre-conditions, Test Steps, Test Data, Expected Result, Actual Result, Status
- **Equivalence Partitioning buckets** split into valid and invalid classes
- **Decision table** — exhaustive combinations of finite-domain conditions
- **State transition model** — transition matrix with ILLEGAL cells as negative tests, plus threshold transitions for lockout counters
- **Exploratory charters** for the human tester
- **Coverage summary** flagging unresolved types

### `generate_manual_test_plan`

**`featureSpec`** (string, required) · **`depth`** (`smoke` | `standard` | `exhaustive`)

The human counterpart to the matrix. Phase A environment setup, Phase B1–B4 happy path / negative / boundary / contextual edge cases, timeboxed exploratory charters, a defect report template with all mandatory fields, STLC exit criteria, and closure metrics.

### `generate_ui_ux_checklist`

**`requirements`** (string, required) · **`scope`** (`full` | `responsive` | `accessibility` | `ux`)

Acts as a Lead UI/UX Auditor. Responsive matrix at 375/414/768/1280/1440/1920px, cross-browser matrix across Blink/WebKit/Gecko with engine-specific risks, visual regression targets with masking guidance, nine interactive component states, ten WCAG 2.1 AA criteria, five UX usability metrics with the observation protocol, and the top three highest-risk flows ranked by blast radius.

### `generate_automation_script`

**`framework`** (`playwright` | `cypress` | `jest`, required) · **`flowDescription`** (string, required) · **`coverage`** (`functional` | `full`)

Emits a Page Object Model and spec. At `full` coverage it also emits a data-driven spec (script separated from dataset), a responsive + visual regression spec with cross-browser project config, a component state spec, an accessibility spec wired to axe, and a BDD `.feature` file in Given/When/Then form. All waits are explicit and condition-based — never a fixed sleep.

### `generate_api_contract_tests`

**`apiSpec`** (string, required) · **`framework`** (`supertest` | `playwright` | `pytest`)

Parses REST routes, OpenAPI path blocks, and GraphQL operations. Generates the status-code contract appropriate to each verb, a missing-required-field case per field, response schema and content-type assertions, error-envelope consistency checks that guard against internal leakage, and a universal contract checklist.

### `generate_test_strategy`

**`projectContext`** (string, required) · **`riskProfile`** (`prototype` | `standard` | `regulated`)

Detects domain, scale, and compliance regime, then tailors: the seven core testing principles applied to that context, 70/20/10 pyramid allocation, all six STLC phases, test type selection with cadence and priority, a non-functional plan (load, stress, soak, spike, security, a11y, compatibility), alpha/beta/UAT gates, automate-vs-manual guidance, CI gating policy, test data isolation rules, entry/exit criteria, closure metrics, and an explicit residual risk statement.

### `run_local_test_suite`

**`command`** (string, required)

Returns status, exit code, duration, runner summary, and the full stdout/stderr. A failing suite comes back as a readable result with `isError: true` — never as a protocol crash.

**Safety boundary.** Execution uses `execFile` with `shell: false` and a tokenized argv array, so shell injection is structurally impossible. A sanitizer runs first as defense-in-depth and rejects shell metacharacters, executables outside the approved runner allowlist, destructive tokens anywhere in the command, and path arguments that escape the workspace root (including via symlink). Bounded at 300s and a 10MB buffer.

### `parse_error_logs`

**`rawLogs`** (string, required) · **`format`** (`json` | `jira` | `both`)

Handles Node, browser, Python, Java, and Jest/Vitest failure output. Returns a deterministic `defectId`, error class and category, severity, component, environment specs extracted from the log (with missing fields named explicitly), pre-conditions, steps to reproduce, impacted segments with dependency frames flagged, assertion deltas, fix vectors, regression recommendations, and a category-appropriate evidence list. `format: "jira"` renders it as ready-to-paste Jira wiki markup.

---

## Project Structure

```
index.js                      SDK transport wiring and boot. Nothing else.
lib/
  config.js                   Operational limits and the workspace root
  errors.js                   ToolInputError — caller mistake, not server fault
  validation.js               Hand-rolled argument validation
  format/
    text.js                   Case helpers, table rendering, ANSI stripping
    result.js                 MCP result envelopes (toolText / toolJson / toolError)
  security/
    workspace.js              Workspace boundary, including symlink escape
    command.js                Test-command sanitizer
    exec.js                   execFile with shell:false; stdio piped
  analysis/
    source.js                 Parameter extraction, constraints, type inference
    flows.js                  User-flow parsing and action classification
    risk.js                   Flow risk weighting
    error-logs.js             Stack trace parsing and environment extraction
  catalog/                    Static domain data: defects, ui, manual, strategy, api
  design/                     BVA, test cases, decision tables, state transitions, charters
  emitters/                   e2e (POM), extensions (DDT/VRT/a11y/BDD), api contracts
  tools/                      One module per tool, plus registry.js
```

Dependency direction is strictly one-way: `tools -> design/emitters -> analysis -> format/security -> config`. Tools are leaves — nothing imports them except the registry — and nothing imports the entrypoint. There are no cycles.

## Local Development

```bash
npm ci
npm test        # 105-check smoke suite
node index.js   # boots silently on stdio
```

`scripts/smoke.mjs` drives a real stdio JSON-RPC session against the built entrypoint and verifies that stdout carries protocol JSON only, that no tool fault escapes as a JSON-RPC error, and that command injection and workspace escape attempts are refused before execution.

## License

MIT
