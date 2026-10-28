/**
 * Data-driven, responsive/VRT, component state, accessibility, and BDD emitters.
 */

import { sampleValueFor, valueSteps } from "../analysis/flows.js";
import { VIEWPORTS } from "../catalog/ui.js";
import { camelCase, kebabCase, pascalCase } from "../format/text.js";

function emitDataDriven(framework, flowName, steps, fileSlug) {
  const target = valueSteps(steps)[0] ?? steps[0];
  const field = target ? target.testId : "input-field";
  const method = target ? target.method : "performStep";
  const pageRef = camelCase(`${flowName}${framework === "jest" ? "Screen" : "Page"}`);

  const dataset = `const CASES = [
  { name: "valid nominal value", input: "${sampleValueFor(target ?? { target: field })}", expectValid: true },
  { name: "empty value", input: "", expectValid: false },
  { name: "whitespace only", input: "   ", expectValid: false },
  { name: "maximum supported length", input: "x".repeat(255), expectValid: false },
  { name: "unicode and emoji", input: "日本語 🚀", expectValid: true },
  { name: "injection payload", input: "' OR 1=1 --", expectValid: false },
];`;

  if (framework === "playwright") {
    return `// ─── file: tests/${fileSlug}.data-driven.spec.js ──────────────────
// Data-Driven Testing: the script is separate from the dataset. Replace CASES
// with a fixture file or database query to scale coverage without new code.
import { test, expect } from "@playwright/test";
import { ${pascalCase(flowName)}Page } from "../pages/${pascalCase(flowName)}Page.js";

${dataset}

for (const testCase of CASES) {
  test(\`${field} — \${testCase.name}\`, async ({ page }) => {
    const ${pageRef} = new ${pascalCase(flowName)}Page(page);
    await ${pageRef}.${method}(testCase.input);
    const error = page.getByTestId("${field}-error");
    if (testCase.expectValid) {
      await expect(error).toHaveCount(0);
    } else {
      await expect(error).toBeVisible();
    }
  });
}
`;
  }

  if (framework === "cypress") {
    return `// ─── file: cypress/e2e/${fileSlug}.data-driven.cy.js ───────────────
// Data-Driven Testing: swap CASES for cy.fixture() to externalise the dataset.
import ${pageRef} from "../pages/${pascalCase(flowName)}Page.js";

${dataset}

describe("${flowName} — data driven", () => {
  CASES.forEach((testCase) => {
    it(\`${field} — \${testCase.name}\`, () => {
      ${pageRef}.${method}(testCase.input);
      cy.get('[data-testid="${field}-error"]').should(
        testCase.expectValid ? "not.exist" : "be.visible"
      );
    });
  });
});
`;
  }

  return `// ─── file: __tests__/${fileSlug}.data-driven.test.js ───────────────
/**
 * @jest-environment jsdom
 * Data-Driven Testing via test.each — one script, many datasets.
 */
import "@testing-library/jest-dom";
import { screen } from "@testing-library/react";
import { ${pascalCase(flowName)}Screen } from "./pages/${pascalCase(flowName)}Screen.js";

${dataset}

describe("${flowName} — data driven", () => {
  it.each(CASES)("${field} — $name", async ({ input, expectValid }) => {
    const ${pageRef} = new ${pascalCase(flowName)}Screen();
    await ${pageRef}.${method}(input);
    const error = screen.queryByTestId("${field}-error");
    if (expectValid) {
      expect(error).not.toBeInTheDocument();
    } else {
      expect(error).toBeInTheDocument();
    }
  });
});
`;
}


function emitResponsive(framework, flowName, steps, fileSlug) {
  const viewportList = VIEWPORTS.map(
    (v) => `  { name: "${kebabCase(v.label)}", width: ${v.width}, height: ${v.height} },`
  ).join("\n");

  if (framework === "playwright") {
    return `// ─── file: playwright.config.js (excerpt) ─────────────────────────
// Cross-browser rendering across all three engines: Blink, WebKit, Gecko.
import { devices } from "@playwright/test";

export default {
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },  // Blink
    { name: "webkit",   use: { ...devices["Desktop Safari"] } },  // WebKit
    { name: "firefox",  use: { ...devices["Desktop Firefox"] } }, // Gecko
    { name: "mobile-safari", use: { ...devices["iPhone 13"] } },
  ],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
};

// ─── file: tests/${fileSlug}.responsive.spec.js ───────────────────
// Responsive + Visual Regression. Baselines are per project, so each engine
// and viewport combination is compared against its own reference image.
import { test, expect } from "@playwright/test";
import { ${pascalCase(flowName)}Page } from "../pages/${pascalCase(flowName)}Page.js";

const VIEWPORTS = [
${viewportList}
];

for (const viewport of VIEWPORTS) {
  test(\`${flowName} renders at \${viewport.name}\`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const ${camelCase(flowName)}Page = new ${pascalCase(flowName)}Page(page);
    await ${camelCase(flowName)}Page.${steps[0]?.method ?? "open"}();

    // No horizontal overflow at any supported width.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflows, \`horizontal scrollbar at \${viewport.name}\`).toBe(false);

    await expect(page).toHaveScreenshot(\`${fileSlug}-\${viewport.name}.png\`, {
      fullPage: true,
      animations: "disabled",           // settle motion to avoid false positives
      mask: [page.getByTestId("timestamp"), page.getByTestId("avatar")], // dynamic regions
    });
  });
}
`;
  }

  if (framework === "cypress") {
    return `// ─── file: cypress/e2e/${fileSlug}.responsive.cy.js ────────────────
// Requires cypress-image-snapshot for the visual regression assertions.
import ${camelCase(flowName)}Page from "../pages/${pascalCase(flowName)}Page.js";

const VIEWPORTS = [
${viewportList}
];

describe("${flowName} — responsive", () => {
  VIEWPORTS.forEach((viewport) => {
    it(\`renders at \${viewport.name}\`, () => {
      cy.viewport(viewport.width, viewport.height);
      ${camelCase(flowName)}Page.${steps[0]?.method ?? "open"}();

      cy.document().then((doc) => {
        expect(
          doc.documentElement.scrollWidth,
          \`horizontal scrollbar at \${viewport.name}\`
        ).to.be.at.most(doc.documentElement.clientWidth);
      });

      cy.matchImageSnapshot(\`${fileSlug}-\${viewport.name}\`, {
        failureThreshold: 0.01,
        failureThresholdType: "percent",
      });
    });
  });
});

// NOTE: Cypress runs on Chromium, Firefox, and WebKit (experimental). Run the
// suite once per browser in CI: cypress run --browser chrome|firefox|webkit
`;
  }

  return `// ─── file: __tests__/${fileSlug}.responsive.test.js ────────────────
/**
 * @jest-environment jsdom
 * jsdom has no layout engine, so it cannot verify rendering or capture pixels.
 * Assert responsive BEHAVIOUR here (which elements mount per breakpoint) and
 * leave visual regression to Playwright or Cypress.
 */
import "@testing-library/jest-dom";
import { screen } from "@testing-library/react";

const VIEWPORTS = [
${viewportList}
];

function setViewport(width, height) {
  window.innerWidth = width;
  window.innerHeight = height;
  window.matchMedia = (query) => ({
    matches: matchMediaQuery(query, width),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  window.dispatchEvent(new Event("resize"));
}

function matchMediaQuery(query, width) {
  const min = query.match(/min-width:\\s*(\\d+)px/);
  const max = query.match(/max-width:\\s*(\\d+)px/);
  if (min && width < Number(min[1])) return false;
  if (max && width > Number(max[1])) return false;
  return true;
}

describe("${flowName} — responsive behaviour", () => {
  it.each(VIEWPORTS)("mounts the correct layout at $name", ({ width, height }) => {
    setViewport(width, height);
    // TODO: render the component and assert the breakpoint-specific affordance,
    // e.g. a hamburger menu below 768px and a full nav bar above it.
    expect(window.innerWidth).toBe(width);
  });
});
`;
}


function emitUiStates(framework, flowName, steps, fileSlug) {
  const interactive = steps.find((s) => s.action === "click") ?? steps[0];
  const locator = interactive ? interactive.testId : "primary-action";

  if (framework === "playwright") {
    return `// ─── file: tests/${fileSlug}.states.spec.js ────────────────────────
// Interactive component states: default, hover, focus, active, disabled, loading.
import { test, expect } from "@playwright/test";

test.describe("${flowName} — component states", () => {
  test("hover does not shift layout", async ({ page }) => {
    const control = page.getByTestId("${locator}");
    const before = await control.boundingBox();
    await control.hover();
    const after = await control.boundingBox();
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
  });

  test("focus ring is visible and keyboard reachable", async ({ page }) => {
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toBeVisible();
    const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline, "focus indicator must not be suppressed").not.toBe("none");
  });

  test("disabled control is inert and announced", async ({ page }) => {
    const control = page.getByTestId("${locator}");
    if (await control.isDisabled()) {
      await expect(control).toHaveAttribute("aria-disabled", "true");
      await control.click({ force: true, trial: true }).catch(() => {});
    }
  });

  test("loading state locks against double submission", async ({ page }) => {
    const control = page.getByTestId("${locator}");
    await control.click();
    await expect(control).toBeDisabled();           // must lock immediately
    await expect(page.getByTestId("loading")).toBeVisible();
  });

  test("empty and error states are explanatory", async ({ page }) => {
    const empty = page.getByTestId("empty-state");
    if (await empty.count()) await expect(empty).toContainText(/\\w{10,}/);
    const error = page.getByTestId("error-message");
    if (await error.count()) await expect(error).toHaveAttribute("role", "alert");
  });
});
`;
  }

  if (framework === "cypress") {
    return `// ─── file: cypress/e2e/${fileSlug}.states.cy.js ────────────────────
describe("${flowName} — component states", () => {
  it("hover does not shift layout", () => {
    cy.get('[data-testid="${locator}"]').then(($el) => {
      const before = $el[0].getBoundingClientRect();
      cy.get('[data-testid="${locator}"]').trigger("mouseover").then(($after) => {
        const after = $after[0].getBoundingClientRect();
        expect(after.x).to.be.closeTo(before.x, 1);
        expect(after.y).to.be.closeTo(before.y, 1);
      });
    });
  });

  it("focus ring is visible and keyboard reachable", () => {
    cy.get('[data-testid="${locator}"]').focus().should("be.focused");
    cy.focused().should(($el) => {
      expect(getComputedStyle($el[0]).outlineStyle).to.not.equal("none");
    });
  });

  it("disabled control is inert and announced", () => {
    cy.get('[data-testid="${locator}"]').then(($el) => {
      if ($el.is(":disabled")) {
        cy.wrap($el).should("have.attr", "aria-disabled", "true");
      }
    });
  });

  it("loading state locks against double submission", () => {
    cy.get('[data-testid="${locator}"]').click();
    cy.get('[data-testid="${locator}"]').should("be.disabled");
    cy.get('[data-testid="loading"]').should("be.visible");
  });
});
`;
  }

  return `// ─── file: __tests__/${fileSlug}.states.test.js ────────────────────
/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

describe("${flowName} — component states", () => {
  it("focus is reachable by keyboard", async () => {
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("disabled control is announced to assistive technology", () => {
    const control = screen.queryByTestId("${locator}");
    if (control && control.hasAttribute("disabled")) {
      expect(control).toHaveAttribute("aria-disabled", "true");
    }
  });

  it("loading state locks against double submission", async () => {
    const user = userEvent.setup();
    const control = screen.getByTestId("${locator}");
    await user.click(control);
    expect(control).toBeDisabled();
  });

  it("error message is announced via a live region", () => {
    const error = screen.queryByTestId("error-message");
    if (error) expect(error).toHaveAttribute("role", "alert");
  });
});
`;
}


function emitAccessibility(framework, flowName, fileSlug) {
  if (framework === "playwright") {
    return `// ─── file: tests/${fileSlug}.a11y.spec.js ──────────────────────────
// Automated scanning covers roughly a third of WCAG. Pair this with the manual
// keyboard and screen-reader checks from generate_ui_ux_checklist.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("${flowName} — accessibility", () => {
  test("has no detectable WCAG 2.1 A/AA violations", async ({ page }) => {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const summary = results.violations.map(
      (v) => \`\${v.id} (\${v.impact}) x\${v.nodes.length}: \${v.help}\`
    );
    expect(summary, summary.join("\\n")).toEqual([]);
  });

  test("zooms to 200% without horizontal scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 800 }); // ~200% of 1280
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflows).toBe(false);
  });
});
`;
  }

  if (framework === "cypress") {
    return `// ─── file: cypress/e2e/${fileSlug}.a11y.cy.js ──────────────────────
// Requires cypress-axe: import "cypress-axe" in cypress/support/e2e.js
describe("${flowName} — accessibility", () => {
  beforeEach(() => {
    cy.injectAxe();
  });

  it("has no detectable WCAG 2.1 A/AA violations", () => {
    cy.checkA11y(null, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
  });
});
`;
  }

  return `// ─── file: __tests__/${fileSlug}.a11y.test.js ──────────────────────
/**
 * @jest-environment jsdom
 * Requires jest-axe.
 */
import { axe, toHaveNoViolations } from "jest-axe";
expect.extend(toHaveNoViolations);

describe("${flowName} — accessibility", () => {
  it("has no detectable WCAG violations", async () => {
    const { container } = render(<${pascalCase(flowName)} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
`;
}


const GHERKIN_KEYWORD = {
  navigate: "Given",
  login: "Given",
  logout: "When",
  fill: "When",
  select: "When",
  upload: "When",
  check: "When",
  click: "When",
  wait: "When",
  assert: "Then",
};


function emitBdd(flowName, steps, flowDescription, fileSlug) {
  const lines = [];
  let lastKeyword = null;

  for (const step of steps) {
    const keyword = GHERKIN_KEYWORD[step.action] ?? "When";
    const text = step.text.replace(/^(?:the\s+)?user\s+/i, "I ").trim();
    lines.push(`    ${keyword === lastKeyword ? "And" : keyword} ${text}`);
    lastKeyword = keyword;
  }
  if (!lines.some((l) => l.includes("Then"))) {
    lines.push("    Then I should see the expected confirmation");
  }

  const valued = valueSteps(steps)[0];
  const field = valued ? valued.target : "the input";

  return `// ─── file: features/${fileSlug}.feature ────────────────────────────
# Behaviour-Driven Development: plain language shared by product, QA, and
# engineering. Bind each step to the Page Object Model above via step
# definitions (Cucumber, cucumber-js, or @cucumber/playwright).

Feature: ${flowName}
  As a user
  I want to ${flowDescription}
  So that the outcome is correct and repeatable

  Background:
    Given the application is available
    And I am starting from a clean session

  Scenario: Happy path
${lines.join("\n")}

  Scenario Outline: ${field} validation
    Given I am on the ${flowName} screen
    When I enter "<value>" into ${field}
    Then I should see "<outcome>"

    Examples:
      | value              | outcome                       |
      |                    | a required-field error        |
      | valid input        | no error                      |
      | ' OR 1=1 --        | the value treated as literal  |
      | <255-character>    | a maximum-length error        |
`;
}

export {
  emitDataDriven,
  emitResponsive,
  emitUiStates,
  emitAccessibility,
  emitBdd,
};
