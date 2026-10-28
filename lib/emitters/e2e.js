/**
 * Page Object Model emitters for Playwright, Cypress, and Jest.
 */

import { sampleValueFor } from "../analysis/flows.js";
import { camelCase, kebabCase } from "../format/text.js";

const SUPPORTED_FRAMEWORKS = ["playwright", "cypress", "jest"];


function emitPlaywright(flowName, steps, flowDescription) {
  const pageClass = `${flowName}Page`;
  const fileSlug = kebabCase(flowName);

  const locators = steps
    .map((s) => `    this.${s.locator} = page.getByTestId("${s.testId}");`)
    .join("\n");

  const methods = steps
    .map((s) => {
      const body = {
        navigate: `    await this.page.goto("/${fileSlug}");`,
        login: `    await this.page.getByTestId("email").fill(credentials.email);\n    await this.page.getByTestId("password").fill(credentials.password);\n    await this.page.getByTestId("submit").click();\n    await this.page.waitForURL("**/dashboard");`,
        logout: `    await this.${s.locator}.click();\n    await this.page.waitForURL("**/login");`,
        fill: `    await this.${s.locator}.fill(value);`,
        select: `    await this.${s.locator}.selectOption(value);`,
        upload: `    await this.${s.locator}.setInputFiles(filePath);`,
        check: `    await this.${s.locator}.check();`,
        wait: `    await this.${s.locator}.waitFor({ state: "visible" });`,
        assert: `    await expect(this.${s.locator}).toBeVisible();`,
        click: `    await this.${s.locator}.click();`,
      }[s.action];

      const signature = {
        login: "credentials",
        fill: "value",
        select: "value",
        upload: "filePath",
      }[s.action] ?? "";

      return `  /** Step ${s.index}: ${s.text} */\n  async ${s.method}(${signature}) {\n${body}\n  }`;
    })
    .join("\n\n");

  const calls = steps
    .map((s) => {
      const arg = {
        login: `{ email: "${sampleValueFor({ target: "email" })}", password: "${sampleValueFor({ target: "password" })}" }`,
        fill: `"${sampleValueFor(s)}"`,
        select: `"${sampleValueFor(s)}"`,
        upload: `"fixtures/sample.png"`,
      }[s.action] ?? "";
      return `    await ${camelCase(pageClass)}.${s.method}(${arg});`;
    })
    .join("\n");

  return `// ─── file: pages/${pageClass}.js ───────────────────────────────────
import { expect } from "@playwright/test";

/**
 * Page Object Model — ${flowName}
 * Flow: ${flowDescription}
 */
export class ${pageClass} {
  constructor(page) {
    this.page = page;
${locators}
  }

${methods}
}

// ─── file: tests/${fileSlug}.spec.js ───────────────────────────────
import { test, expect } from "@playwright/test";
import { ${pageClass} } from "../pages/${pageClass}.js";

test.describe("${flowName}", () => {
  let ${camelCase(pageClass)};

  test.beforeEach(async ({ page }) => {
    ${camelCase(pageClass)} = new ${pageClass}(page);
  });

  test("happy path: ${flowDescription.slice(0, 80)}", async ({ page }) => {
${calls}
  });

  test("negative path: rejects invalid input", async ({ page }) => {
    // TODO: drive the invalid Equivalence Partition from generate_qa_matrix here.
    test.fixme(true, "Populate from the EP invalid-class bucket.");
  });
});
`;
}


function emitCypress(flowName, steps, flowDescription) {
  const pageClass = `${flowName}Page`;
  const fileSlug = kebabCase(flowName);

  const getters = steps
    .map((s) => `  get ${s.locator}() {\n    return cy.get('[data-testid="${s.testId}"]');\n  }`)
    .join("\n\n");

  const methods = steps
    .map((s) => {
      const body = {
        navigate: `    cy.visit("/${fileSlug}");`,
        login: `    cy.get('[data-testid="email"]').type(credentials.email);\n    cy.get('[data-testid="password"]').type(credentials.password, { log: false });\n    cy.get('[data-testid="submit"]').click();\n    cy.url().should("include", "/dashboard");`,
        logout: `    this.${s.locator}.click();\n    cy.url().should("include", "/login");`,
        fill: `    this.${s.locator}.clear().type(value);`,
        select: `    this.${s.locator}.select(value);`,
        upload: `    this.${s.locator}.selectFile(filePath);`,
        check: `    this.${s.locator}.check();`,
        wait: `    this.${s.locator}.should("be.visible");`,
        assert: `    this.${s.locator}.should("be.visible");`,
        click: `    this.${s.locator}.click();`,
      }[s.action];

      const signature = {
        login: "credentials",
        fill: "value",
        select: "value",
        upload: "filePath",
      }[s.action] ?? "";

      return `  /** Step ${s.index}: ${s.text} */\n  ${s.method}(${signature}) {\n${body}\n    return this;\n  }`;
    })
    .join("\n\n");

  const calls = steps
    .map((s) => {
      const arg = {
        login: `{ email: "${sampleValueFor({ target: "email" })}", password: "${sampleValueFor({ target: "password" })}" }`,
        fill: `"${sampleValueFor(s)}"`,
        select: `"${sampleValueFor(s)}"`,
        upload: `"cypress/fixtures/sample.png"`,
      }[s.action] ?? "";
      return `    ${camelCase(pageClass)}.${s.method}(${arg});`;
    })
    .join("\n");

  return `// ─── file: cypress/pages/${pageClass}.js ───────────────────────────
/**
 * Page Object Model — ${flowName}
 * Flow: ${flowDescription}
 */
class ${pageClass} {
${getters}

${methods}
}

export default new ${pageClass}();

// ─── file: cypress/e2e/${fileSlug}.cy.js ───────────────────────────
import ${camelCase(pageClass)} from "../pages/${pageClass}.js";

describe("${flowName}", () => {
  beforeEach(() => {
    cy.clearCookies();
    cy.clearLocalStorage();
  });

  it("happy path: ${flowDescription.slice(0, 80)}", () => {
${calls}
  });

  it("negative path: rejects invalid input", () => {
    // TODO: drive the invalid Equivalence Partition from generate_qa_matrix here.
    cy.log("Populate from the EP invalid-class bucket.");
  });
});
`;
}


function emitJest(flowName, steps, flowDescription) {
  const pageClass = `${flowName}Screen`;
  const fileSlug = kebabCase(flowName);

  const getters = steps
    .map((s) => `  get ${s.locator}() {\n    return screen.getByTestId("${s.testId}");\n  }`)
    .join("\n\n");

  const methods = steps
    .map((s) => {
      const body = {
        navigate: `    render(<${flowName} />);`,
        login: `    await this.user.type(screen.getByTestId("email"), credentials.email);\n    await this.user.type(screen.getByTestId("password"), credentials.password);\n    await this.user.click(screen.getByTestId("submit"));`,
        logout: `    await this.user.click(this.${s.locator});`,
        fill: `    await this.user.clear(this.${s.locator});\n    await this.user.type(this.${s.locator}, value);`,
        select: `    await this.user.selectOptions(this.${s.locator}, value);`,
        upload: `    await this.user.upload(this.${s.locator}, file);`,
        check: `    await this.user.click(this.${s.locator});`,
        wait: `    await waitFor(() => expect(this.${s.locator}).toBeVisible());`,
        assert: `    expect(this.${s.locator}).toBeVisible();`,
        click: `    await this.user.click(this.${s.locator});`,
      }[s.action];

      const signature = {
        login: "credentials",
        fill: "value",
        select: "value",
        upload: "file",
      }[s.action] ?? "";

      const isAsync = s.action !== "assert";
      return `  /** Step ${s.index}: ${s.text} */\n  ${isAsync ? "async " : ""}${s.method}(${signature}) {\n${body}\n  }`;
    })
    .join("\n\n");

  const calls = steps
    .map((s) => {
      const arg = {
        login: `{ email: "${sampleValueFor({ target: "email" })}", password: "${sampleValueFor({ target: "password" })}" }`,
        fill: `"${sampleValueFor(s)}"`,
        select: `"${sampleValueFor(s)}"`,
        upload: `new File(["x"], "sample.png", { type: "image/png" })`,
      }[s.action] ?? "";
      const isAsync = s.action !== "assert";
      return `    ${isAsync ? "await " : ""}${camelCase(pageClass)}.${s.method}(${arg});`;
    })
    .join("\n");

  return `// ─── file: __tests__/pages/${pageClass}.js ─────────────────────────
import { screen, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Page Object Model — ${flowName}
 * Flow: ${flowDescription}
 */
export class ${pageClass} {
  constructor() {
    this.user = userEvent.setup();
  }

${getters}

${methods}
}

// ─── file: __tests__/${fileSlug}.test.js ───────────────────────────
/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { ${pageClass} } from "./pages/${pageClass}.js";

describe("${flowName}", () => {
  let ${camelCase(pageClass)};

  beforeEach(() => {
    jest.clearAllMocks();
    ${camelCase(pageClass)} = new ${pageClass}();
  });

  it("happy path: ${flowDescription.slice(0, 80)}", async () => {
${calls}
  });

  it("negative path: rejects invalid input", async () => {
    // TODO: drive the invalid Equivalence Partition from generate_qa_matrix here.
    expect(true).toBe(true);
  });
});
`;
}


const FRAMEWORK_EMITTERS = {
  playwright: emitPlaywright,
  cypress: emitCypress,
  jest: emitJest,
};

export {
  SUPPORTED_FRAMEWORKS,
  FRAMEWORK_EMITTERS,
};
