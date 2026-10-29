# Universal QA Expert Engine MCP Skill

An automated Model Context Protocol (MCP) server that turns AI coding agents (Claude Code, Cursor, Antigravity, Codex, VS Code) into a Senior QA Automation and Manual Test Engineer.

Eight tools covering black-box test design, manual and exploratory testing, UI/UX auditing, API contract testing, automation scaffolding, test execution, defect triage, and STLC strategy.

## Installation

Every editor stores MCP config somewhere different. The simplest route is to let
your agent write it:

> Add the mcp-qa-expert-engine MCP server to my config

Or run one command:

```bash
# Claude Code
claude mcp add qa-expert -- npx -y mcp-qa-expert-engine

# VS Code
code --add-mcp '{"name":"qa-expert","command":"npx","args":["-y","mcp-qa-expert-engine"]}'
```

<details>
<summary>Configure it by hand instead</summary>

For Cursor, Antigravity, Codex, or any other MCP client — add this to the server
block your editor uses (commonly `.cursor/mcp.json`, `.vscode/mcp.json`, or the
MCP panel in your extension):

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

</details>

Restart the editor afterwards — most clients only read MCP config at startup.
Then ask *"what QA tools do you have?"* and you should see eight.

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

Parses function signatures (JS/TS/Python), TypeScript interfaces, git diffs, and markdown requirement bullets. Extracts parameters, infers types, and mines declared constraints — numeric ranges (`min 1, max 500`, `between 1 and 12`), length ranges (`6-12 characters`), exact lengths (`16 digits`), enum unions (`'GB' | 'US'`) and nullability. Emits:

- **Parameter inventory** with inferred types and detected constraints
- **Test case specification** carrying all nine standard attributes — ID (`TC_<MODULE>_001`), Component/Module, action-verb Title, Pre-conditions, Test Steps, Test Data, Expected Result, Actual Result, Status
- **Equivalence Partitioning buckets** split into valid and invalid classes
- **Decision table** — exhaustive combinations of finite-domain conditions
- **State transition model** — transition matrix with ILLEGAL cells as negative tests, plus threshold transitions for lockout counters
- **Exploratory charters** for the human tester
- **Requirements gaps** — every parameter with no stated bound, which platform limits were substituted in its place, and the question to put back to the specification
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
npm test        # 135-check smoke suite
node index.js   # boots silently on stdio
```

`scripts/smoke.mjs` drives a real stdio JSON-RPC session against the built entrypoint and verifies that stdout carries protocol JSON only, that no tool fault escapes as a JSON-RPC error, and that command injection and workspace escape attempts are refused before execution.

## Updating

If you installed without pinning a version, **restart your editor**. The server runs
as a long-lived process started at editor launch, so a new version is only picked up
when that process restarts — `npx` then resolves the latest release.

To confirm which version you are on, check your editor's MCP server log. The server
announces itself on startup:

```
QA Expert MCP Server v1.3.0 running via stdio. 8 tools registered.
```

If it still reports an old version after a restart, `npx` is serving a cached install.
Clear it:

```bash
npm cache clean --force
```

If you pinned a version (`mcp-qa-expert-engine@1.2.0`), update the pin in your MCP
config and restart. Pinning trades automatic updates for reproducibility — reasonable
for a team that wants every member on an identical build.

## Platform Support

macOS and Linux are fully supported and exercised by the test suite.

On **Windows**, `run_local_test_suite` runs through `cmd.exe`, because npm, npx
and yarn resolve to `.cmd` shims that Node refuses to spawn without a shell.
The command sanitizer compensates by rejecting every cmd.exe metacharacter
(`& | < > ( ) % ^ ` $ ;` and newlines) before execution, so no command
separator can reach the shell — but on Windows the protection is the filter
rather than the absence of a shell. The other seven tools generate text and
behave identically on every platform.

Windows behaviour has not been verified on a Windows host. If you run it there,
a report either way is welcome.

## Changelog

### 1.3.0

- Added: a **Requirements Gaps** review, emitted before the test cases. Boundary Value Analysis is only as good as the stated boundary; where the input declares none, the generated cases fall back to platform limits (int32 max, 2^53, common column widths), which exercise the runtime rather than the business rule. That substitution is now named explicitly, per parameter, with the question to put back to the specification.
- The report distinguishes a wholly missing range from a missing upper or lower bound, and lists only the probes actually substituted for that gap.
- Unstated nullability is reported separately, with the assumption made on the reader's behalf.
- A fully specified input gets an explicit all-clear rather than silence.
- Added: the boot banner now states the running version, so a user can tell which build their editor started.
- Added: an **Updating** section — how a new release reaches an existing install, and what to do if npx serves a cached one.
- Eleven checks added; suite is now 135.

### 1.2.1

- Fixed: on a field with a declared minimum length, the empty-string and single-character cases were marked "accept" while the minLength-1 case was marked "reject" — the matrix contradicted its own extracted constraint. Both now respect the minimum.
- Fixed: the test case id truncated mid-word, so `applyPromoCode` produced `TC_PROMOCOD_001`. It now uses a whole word: `TC_PROMO_001`.
- Five consistency checks added; suite is now 124.

### 1.2.0

- Fixed: generic type parameters hid the argument list, so `function fetchPage<T>(url, limit)` extracted nothing.
- Fixed: a single-line class body (`class Cart { addItem(sku) {} }`) extracted nothing.
- Fixed: a single-line interface (`interface Order { id: string }`) extracted nothing.
- Added: Windows `.cmd`/`.exe` shims are matched against the runner allowlist, so `npm.cmd test` is recognised — and destructive tokens are caught through their shims too (`rm.cmd`, `sudo.exe`).
- Added: `%` and `^` are now rejected as cmd.exe metacharacters on every platform.
- Suite is now 119 checks. A ten-shape parser corpus that previously passed 7/10 now passes 10/10.

### 1.1.1

- Fixed: a length range such as `6-12 characters` was read as an exact length of 12, so boundary cases were generated around the wrong value. Ranges and exact lengths are now distinguished.
- Fixed: `and` joining two actions ("enters a code **and** sees the total") collapsed into a single step, producing welded locator names. It now splits on `and` only where it joins two actions, leaving noun phrases ("terms and conditions") intact.
- Fixed: a field with a declared length but a numeric-sounding name (`cardNumber`, `16 digits`) was typed as a number. 16 digits exceeds `MAX_SAFE_INTEGER` and leading zeros are lost, so an explicit length constraint now outranks the name.
- Seven regression tests added; suite is now 112 checks.

### 1.1.0

- Added `generate_ui_ux_checklist`, `generate_manual_test_plan`, `generate_api_contract_tests` and `generate_test_strategy`.
- `generate_qa_matrix` gained nine-attribute test cases, decision tables, state transition models and exploratory charters.
- `parse_error_logs` gained environment extraction, pre-conditions, evidence lists and Jira rendering.
- `generate_automation_script` gained data-driven, responsive/visual-regression, component-state, accessibility and BDD output.

## License

MIT
