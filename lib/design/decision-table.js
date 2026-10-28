/**
 * Decision table generation over finite-domain conditions
 * (Senior-QA-Engineer.md section 5).
 */

import { renderTable } from "../format/text.js";

const MAX_DECISION_RULES = 32;

function buildDecisionTable(parameters) {
  const finite = parameters.filter(
    (p) => p.type === "boolean" || (p.type === "enum" && Array.isArray(p.constraints.enum))
  );
  if (finite.length < 2) return null;

  const used = finite.slice(0, 3);
  const domains = used.map((p) =>
    p.type === "boolean" ? ["true", "false"] : p.constraints.enum.slice(0, 4)
  );

  let rules = [[]];
  for (const domain of domains) {
    const next = [];
    for (const rule of rules) for (const value of domain) next.push([...rule, value]);
    rules = next;
  }

  const total = rules.length;
  const shown = rules.slice(0, MAX_DECISION_RULES);

  const headers = ["Rule", ...used.map((p) => p.name), "Expected Action"];
  const rows = shown.map((rule, i) => [
    `R${String(i + 1).padStart(2, "0")}`,
    ...rule,
    i === 0
      ? "Baseline / happy path — confirm the primary success outcome"
      : "Derive from requirements; confirm it differs from the baseline where business rules dictate",
  ]);

  return {
    dimensions: used.map((p, i) => `${p.name}(${domains[i].length})`).join(" x "),
    total,
    shown: shown.length,
    truncated: total > MAX_DECISION_RULES,
    table: renderTable(headers, rows),
    skipped: finite.length > 3 ? finite.slice(3).map((p) => p.name) : [],
  };
}

export {
  MAX_DECISION_RULES,
  buildDecisionTable,
};
