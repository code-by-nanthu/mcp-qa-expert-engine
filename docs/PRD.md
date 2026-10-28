### Product Requirement Document (PRD)

### Project Name: Universal QA Expert Engine MCP Skill

**Version:** 1.0.0
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

The following foundational layout has been fully structured, wired, and verified:

* **Executable Entrypoint (index.js):** Properly contains the #!/usr/bin/env node shebang line and executable file boundaries.
* **Protocol Handlers:** Registered ListToolsRequestSchema and CallToolRequestSchema handlers mapping standard RPC payloads seamlessly.
* **Tool 1 (generate_qa_matrix):** Fully takes in a string block of local source code change records or markdown design requirements and produces structured, domain-certified Boundary Value Analysis (BVA) matrices and Equivalence Partitioning (EP) data buckets.

### 4. Remaining Features Roadmap (What to Implement Next)

To reach true Senior QA performance, the repository requires the addition of the following three functional tools inside index.js:

### Tool 2: run_local_test_suite

* **Objective:** Allows the AI agent to execute local testing suites directly inside the user's terminal workspace environment and securely interpret the log stream back.
* **Input Parameters:**

  * command (string, e.g., "npm test", "pytest", "npm run test:coverage").
* **Execution Mechanism:** Node.js child_process.exec execution block.
* **Safety Boundary:** Absolute validation sanitization to stop execution chains if risky terminal commands (e.g., ; rm -rf) are appended.

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
