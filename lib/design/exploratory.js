/**
 * Session-based exploratory test charters for the human tester.
 */

/* ── Exploratory test charters (Manual-Testing.md sections 1-2) ─────────── */

function buildExploratoryCharters(parameters, moduleInfo) {
  const target = moduleInfo.label;
  const charters = [
    {
      charter: `Explore ${target} input handling with boundary and malformed data to discover unhandled crashes and unclear error messages`,
      timebox: "45 min",
      heuristics: "Goldilocks (too big / too small / just right); CRUD; error-message clarity",
      capture: "Stack traces, raw error text shown to the user, HTTP status codes",
    },
    {
      charter: `Explore ${target} under rapid repeated submission to discover duplicate records and race conditions`,
      timebox: "30 min",
      heuristics: "Double-click the submit control; resubmit before the response lands; two tabs at once",
      capture: "Duplicate rows, conflicting totals, network waterfall",
    },
    {
      charter: `Explore ${target} with oversized and pasted content to discover layout breakage and silent truncation`,
      timebox: "30 min",
      heuristics: "Paste a multi-paragraph block; paste emoji and RTL text; paste formatted HTML",
      capture: "Screenshots of clipped layout, stored vs displayed value, console warnings",
    },
    {
      charter: `Explore ${target} under interruption to discover inconsistent persisted state`,
      timebox: "45 min",
      heuristics: "Kill the network mid-request; browser back during submit; refresh mid-flow; session expiry",
      capture: "Database state vs UI state, retry behaviour, data loss",
    },
    {
      charter: `Explore ${target} across locale, timezone, and currency changes to discover formatting and calculation defects`,
      timebox: "30 min",
      heuristics: "Switch language mid-flow; set a UTC-offset timezone; use a comma-decimal locale",
      capture: "Misformatted dates and amounts, untranslated strings, off-by-one day errors",
    },
    {
      charter: `Explore ${target} with varied roles and permissions to discover authorisation bypasses`,
      timebox: "45 min",
      heuristics: "Lower-privilege account; direct URL access; tampered identifiers in the request",
      capture: "Responses that should be 403, leaked fields, visible controls that should be hidden",
    },
  ];

  const formatted = parameters.filter((p) => /email|url|phone|password|card|postcode|zip/i.test(p.name));
  if (formatted.length) {
    charters.push({
      charter: `Explore ${target} format validation for ${formatted.map((p) => p.name).join(", ")} to discover over-strict and under-strict rules`,
      timebox: "30 min",
      heuristics: "Valid-but-unusual real values; internationally valid formats; leading/trailing whitespace",
      capture: "Legitimate values wrongly rejected, invalid values wrongly accepted",
    });
  }

  return charters;
}


function renderCharter(entry, index) {
  return [
    `EXP-${String(index + 1).padStart(2, "0")}  (timebox: ${entry.timebox})`,
    `  Charter    : ${entry.charter}`,
    `  Heuristics : ${entry.heuristics}`,
    `  Capture    : ${entry.capture}`,
  ].join("\n");
}

export {
  buildExploratoryCharters,
  renderCharter,
};
