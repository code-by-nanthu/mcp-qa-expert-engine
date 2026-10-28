/**
 * The tool catalogue. One entry per tool; the dispatch table is derived from it.
 */

import { SUPPORTED_FRAMEWORKS } from "../emitters/e2e.js";
import { handleGenerateApiContractTests } from "./generate-api-contract-tests.js";
import { handleGenerateAutomationScript } from "./generate-automation-script.js";
import { handleGenerateManualTestPlan } from "./generate-manual-test-plan.js";
import { handleGenerateQaMatrix } from "./generate-qa-matrix.js";
import { handleGenerateTestStrategy } from "./generate-test-strategy.js";
import { handleGenerateUiUxChecklist } from "./generate-ui-ux-checklist.js";
import { handleParseErrorLogs } from "./parse-error-logs.js";
import { handleRunLocalTestSuite } from "./run-local-test-suite.js";

const TOOLS = [
  {
    name: "generate_qa_matrix",
    description:
      "Analyzes raw code diffs, function signatures, type declarations, or markdown requirements and derives a parametric Boundary Value Analysis matrix plus Equivalence Partitioning buckets for every detected parameter.",
    inputSchema: {
      type: "object",
      properties: {
        codeSnippet: {
          type: "string",
          description:
            "Source code, a git diff, a TypeScript interface, or markdown requirement bullets needing a test design plan.",
        },
      },
      required: ["codeSnippet"],
    },
    handler: handleGenerateQaMatrix,
  },
  {
    name: "run_local_test_suite",
    description:
      "Executes a local test command inside the workspace and returns the captured stdout/stderr, exit code, and triage summary. Only approved test runners are permitted; shell chaining and destructive commands are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            'The test command to execute, e.g. "npm test", "npm run test:coverage", "pytest -q".',
        },
      },
      required: ["command"],
    },
    handler: handleRunLocalTestSuite,
  },
  {
    name: "parse_error_logs",
    description:
      "Ingests raw terminal crashes, browser console output, or stack traces and returns a structured JSON defect record with reproduction steps, impacted code segments, error classification, and suggested fix vectors.",
    inputSchema: {
      type: "object",
      properties: {
        rawLogs: {
          type: "string",
          description: "The raw, unformatted error trace or log output.",
        },
        format: {
          type: "string",
          enum: ["json", "jira", "both"],
          description:
            'Output format. "json" is the machine-readable defect record (default). "jira" renders a ready-to-paste Jira wiki-markup bug report. "both" returns the Jira report followed by the JSON record.',
        },
      },
      required: ["rawLogs"],
    },
    handler: handleParseErrorLogs,
  },
  {
    name: "generate_automation_script",
    description:
      "Generates a production-ready Page Object Model automation script for the requested framework, derived from a plain-language description of the user flow.",
    inputSchema: {
      type: "object",
      properties: {
        framework: {
          type: "string",
          enum: SUPPORTED_FRAMEWORKS,
          description: "Target automation framework.",
        },
        flowDescription: {
          type: "string",
          description:
            'The user journey to automate, e.g. "user logs in, visits the billing screen, adds a valid credit card".',
        },
        coverage: {
          type: "string",
          enum: ["functional", "full"],
          description:
            'How much to emit. "functional" is the Page Object Model and happy/negative spec only. "full" adds data-driven, responsive + visual regression, component state, accessibility, and BDD artifacts. Defaults to "full".',
        },
      },
      required: ["framework", "flowDescription"],
    },
    handler: handleGenerateAutomationScript,
  },
  {
    name: "generate_ui_ux_checklist",
    description:
      "Acts as a Lead UI/UX Auditor. Analyses a requirements page or list of user journeys and produces a responsive viewport matrix, cross-browser rendering matrix, visual regression targets, interactive component state checks, WCAG 2.1 AA criteria, UX usability metrics, and the highest-risk flows a human tester should verify manually.",
    inputSchema: {
      type: "object",
      properties: {
        requirements: {
          type: "string",
          description:
            "A requirements page, feature specification, or list of user journeys to audit.",
        },
        scope: {
          type: "string",
          enum: ["full", "responsive", "accessibility", "ux"],
          description:
            "Which portion of the audit to emit. Defaults to \"full\".",
        },
      },
      required: ["requirements"],
    },
    handler: handleGenerateUiUxChecklist,
  },
  {
    name: "generate_manual_test_plan",
    description:
      "Produces a human-executable manual test plan from a feature specification: environment setup, happy-path checklist, negative-path and boundary passes, contextual edge cases, timeboxed exploratory charters, a defect report template, and STLC exit criteria with closure metrics.",
    inputSchema: {
      type: "object",
      properties: {
        featureSpec: {
          type: "string",
          description:
            "The feature specification, user story, or requirements text to build a manual test plan from.",
        },
        depth: {
          type: "string",
          enum: ["smoke", "standard", "exhaustive"],
          description:
            "How much of the plan to emit. \"smoke\" is happy path only; \"exhaustive\" includes every contextual edge case. Defaults to \"standard\".",
        },
      },
      required: ["featureSpec"],
    },
    handler: handleGenerateManualTestPlan,
  },
  {
    name: "generate_api_contract_tests",
    description:
      "Generates component/API contract tests from a REST, OpenAPI, or GraphQL specification: status-code contracts per verb, request payload validation, response schema and content-type assertions, authentication and authorisation boundaries, error-envelope consistency, and a universal contract checklist. Covers the middle tier of the testing pyramid without a UI.",
    inputSchema: {
      type: "object",
      properties: {
        apiSpec: {
          type: "string",
          description:
            "The API specification: REST routes (e.g. \"POST /api/v1/orders\"), an OpenAPI path block, or GraphQL operations, optionally with field definitions.",
        },
        framework: {
          type: "string",
          enum: ["supertest", "playwright", "pytest"],
          description: "Target test framework. Defaults to \"supertest\".",
        },
      },
      required: ["apiSpec"],
    },
    handler: handleGenerateApiContractTests,
  },
  {
    name: "generate_test_strategy",
    description:
      "Produces an STLC test strategy and plan tailored to a project: context and compliance analysis, core testing principles applied to the domain, test pyramid allocation, test type selection with cadence and priority, a non-functional test plan (load, stress, soak, spike, security, accessibility, compatibility), release validation phases (alpha/beta/UAT), automate-vs-manual guidance, CI gating policy, test data isolation rules, entry and exit criteria, closure metrics, and a residual risk statement.",
    inputSchema: {
      type: "object",
      properties: {
        projectContext: {
          type: "string",
          description:
            "What the system is, its stack, scale, and any compliance regime. E.g. \"multi-tenant SaaS billing dashboard, React + Node, 50k daily users, PCI DSS in scope\".",
        },
        riskProfile: {
          type: "string",
          enum: ["prototype", "standard", "regulated"],
          description:
            "Rigor tier. \"prototype\" trades depth for speed; \"regulated\" adds compliance gating. Defaults to \"standard\".",
        },
      },
      required: ["projectContext"],
    },
    handler: handleGenerateTestStrategy,
  },
];


const HANDLERS = Object.fromEntries(TOOLS.map((t) => [t.name, t.handler]));

export {
  TOOLS,
  HANDLERS,
};
