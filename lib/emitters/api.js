/**
 * API contract test emitters for supertest, Playwright, and pytest.
 */

import path from "node:path";
import { sampleValueFor } from "../analysis/flows.js";
import { STATUS_CONTRACT } from "../catalog/api.js";
import { kebabCase } from "../format/text.js";

function parseEndpoints(spec) {
  const endpoints = [];
  const seen = new Set();

  for (const m of spec.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s"'`,)\]]*)/gi)) {
    const method = m[1].toUpperCase();
    const path = m[2];
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({ method, path, kind: "rest" });
  }

  for (const m of spec.matchAll(/\b(query|mutation|subscription)\s+(\w+)/gi)) {
    const key = `${m[1].toLowerCase()} ${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({ method: m[1].toLowerCase(), path: m[2], kind: "graphql" });
  }

  return endpoints.slice(0, 10);
}


function endpointSlug(endpoint) {
  return kebabCase(`${endpoint.method} ${endpoint.path.replace(/[{}:]/g, " ")}`) || "endpoint";
}


function buildSamplePayload(parameters) {
  if (parameters.length === 0) return `{ /* TODO: populate from the specification */ }`;
  const entries = parameters.slice(0, 8).map((p) => {
    switch (p.type) {
      case "number": return `    ${p.name}: ${p.constraints.min ?? 1}`;
      case "boolean": return `    ${p.name}: true`;
      case "enum": return `    ${p.name}: ${JSON.stringify(p.constraints.enum?.[0] ?? "value")}`;
      case "array": return `    ${p.name}: []`;
      case "date": return `    ${p.name}: "2024-01-15T00:00:00Z"`;
      default: return `    ${p.name}: ${JSON.stringify(sampleValueFor({ target: p.name }))}`;
    }
  });
  return `{\n${entries.join(",\n")}\n  }`;
}


function emitSupertest(endpoints, parameters, specName) {
  const payload = buildSamplePayload(parameters);
  const required = parameters.filter((p) => p.constraints.required || !p.constraints.optional);
  const blocks = endpoints.map((endpoint) => {
    const statuses = STATUS_CONTRACT[endpoint.method] ?? STATUS_CONTRACT.GET;
    const call =
      endpoint.method === "GET" || endpoint.method === "DELETE"
        ? `.${endpoint.method.toLowerCase()}("${endpoint.path}")`
        : `.${endpoint.method.toLowerCase()}("${endpoint.path}").send(VALID_PAYLOAD)`;

    const statusTests = statuses
      .map(([code, condition]) => {
        const setup =
          code === "401" ? "\n      // no Authorization header"
            : code === "403" ? "\n      .set(\"Authorization\", `Bearer ${LOW_PRIVILEGE_TOKEN}`)"
            : "\n      .set(\"Authorization\", `Bearer ${TOKEN}`)";
        return `  it("${code} — ${condition}", async () => {
    await request(app)
      ${call}${setup}
      .expect(${code});
  });`;
      })
      .join("\n\n");

    const fieldTests = required
      .slice(0, 5)
      .map(
        (p) => `  it("400 — rejects a payload missing ${p.name}", async () => {
    const { ${p.name}: _omitted, ...incomplete } = VALID_PAYLOAD;
    const res = await request(app)
      .${(endpoint.method === "GET" ? "post" : endpoint.method.toLowerCase())}("${endpoint.path}")
      .set("Authorization", \`Bearer \${TOKEN}\`)
      .send(incomplete)
      .expect(400);
    expect(res.body.error).toBeDefined();
    expect(JSON.stringify(res.body)).toContain("${p.name}");
  });`
      )
      .join("\n\n");

    return `describe("${endpoint.method} ${endpoint.path} — contract", () => {
${statusTests}

${fieldTests}

  it("returns the documented response schema", async () => {
    const res = await request(app)
      ${call}
      .set("Authorization", \`Bearer \${TOKEN}\`);
    expect(res.headers["content-type"]).toMatch(/application\\/json/);
    // TODO: assert against the published JSON Schema / OpenAPI component.
    expect(res.body).toBeDefined();
  });

  it("error envelope is consistent", async () => {
    const res = await request(app)
      .${endpoint.method.toLowerCase()}("${endpoint.path}")
      .set("Authorization", "Bearer invalid")
      .send(${endpoint.method === "GET" || endpoint.method === "DELETE" ? "" : "VALID_PAYLOAD"});
    if (res.status >= 400) {
      expect(res.body).toHaveProperty("error");
      expect(JSON.stringify(res.body)).not.toMatch(/at \\w+ \\(|SELECT |node_modules/);
    }
  });
});`;
  });

  return `// ─── file: __tests__/${kebabCase(specName)}.contract.test.js ──────────
// API contract tests — the middle tier of the testing pyramid. No UI involved.
import request from "supertest";
import app from "../src/app.js";

const TOKEN = process.env.TEST_TOKEN ?? "replace-with-a-valid-token";
const LOW_PRIVILEGE_TOKEN = process.env.TEST_LOW_TOKEN ?? "replace-with-a-reader-token";

const VALID_PAYLOAD = ${payload};

${blocks.join("\n\n")}
`;
}


function emitPlaywrightApi(endpoints, parameters, specName) {
  const payload = buildSamplePayload(parameters);
  const blocks = endpoints.map((endpoint) => {
    const statuses = STATUS_CONTRACT[endpoint.method] ?? STATUS_CONTRACT.GET;
    const body =
      endpoint.method === "GET" || endpoint.method === "DELETE" ? "" : ", { data: VALID_PAYLOAD }";
    const statusTests = statuses
      .map(
        ([code, condition]) => `  test("${code} — ${condition}", async ({ request }) => {
    const response = await request.${endpoint.method.toLowerCase()}("${endpoint.path}"${body});
    expect(response.status()).toBe(${code});
  });`
      )
      .join("\n\n");

    return `test.describe("${endpoint.method} ${endpoint.path} — contract", () => {
${statusTests}

  test("returns JSON matching the documented schema", async ({ request }) => {
    const response = await request.${endpoint.method.toLowerCase()}("${endpoint.path}"${body});
    expect(response.headers()["content-type"]).toContain("application/json");
    const body_ = await response.json();
    expect(body_).toBeDefined();
  });

  test("error body leaks no internals", async ({ request }) => {
    const response = await request.${endpoint.method.toLowerCase()}("${endpoint.path}/does-not-exist");
    if (response.status() >= 400) {
      const text_ = await response.text();
      expect(text_).not.toMatch(/at \\w+ \\(|SELECT |node_modules/);
    }
  });
});`;
  });

  return `// ─── file: tests/${kebabCase(specName)}.contract.spec.js ──────────────
// Playwright API testing — runs without a browser page.
import { test, expect } from "@playwright/test";

const VALID_PAYLOAD = ${payload};

// playwright.config.js: use: { baseURL: process.env.API_BASE_URL,
//   extraHTTPHeaders: { Authorization: \`Bearer \${process.env.TEST_TOKEN}\` } }

${blocks.join("\n\n")}
`;
}


function emitPytestApi(endpoints, parameters, specName) {
  const pyPayload = parameters.length
    ? parameters
        .slice(0, 8)
        .map((p) => {
          switch (p.type) {
            case "number": return `    "${p.name}": ${p.constraints.min ?? 1},`;
            case "boolean": return `    "${p.name}": True,`;
            case "enum": return `    "${p.name}": "${p.constraints.enum?.[0] ?? "value"}",`;
            case "array": return `    "${p.name}": [],`;
            default: return `    "${p.name}": "${sampleValueFor({ target: p.name })}",`;
          }
        })
        .join("\n")
    : '    # TODO: populate from the specification';

  const blocks = endpoints.map((endpoint) => {
    const statuses = STATUS_CONTRACT[endpoint.method] ?? STATUS_CONTRACT.GET;
    const fn = endpoint.method.toLowerCase();
    const body = fn === "get" || fn === "delete" ? "" : ", json=VALID_PAYLOAD";
    const slug = endpointSlug(endpoint).replace(/-/g, "_");

    const statusTests = statuses
      .map(
        ([code, condition]) => `def test_${slug}_${code}(client):
    """${code} — ${condition}"""
    response = client.${fn}("${endpoint.path}"${body})
    assert response.status_code == ${code}`
      )
      .join("\n\n\n");

    return `${statusTests}


def test_${slug}_schema(client):
    """Response matches the documented schema and content type."""
    response = client.${fn}("${endpoint.path}"${body})
    assert "application/json" in response.headers["content-type"]
    assert response.json() is not None


def test_${slug}_error_envelope(client):
    """Error bodies share one shape and leak no internals."""
    response = client.${fn}("${endpoint.path}/does-not-exist")
    if response.status_code >= 400:
        assert "error" in response.json()
        assert "Traceback" not in response.text`;
  });

  return `# ─── file: tests/test_${kebabCase(specName).replace(/-/g, "_")}_contract.py ──────
# API contract tests — the middle tier of the testing pyramid.
import pytest

VALID_PAYLOAD = {
${pyPayload}
}


${blocks.join("\n\n\n")}
`;
}


const API_EMITTERS = {
  supertest: emitSupertest,
  playwright: emitPlaywrightApi,
  pytest: emitPytestApi,
};

export {
  parseEndpoints,
  API_EMITTERS,
};
