/**
 * parse-error-logs — see the tool it backs.
 */

import { createHash } from "node:crypto";
import { buildEvidenceList, buildFixVectors, buildPreConditions, buildReproSteps, classifyError, deriveComponent, detectLanguage, extractAssertionDelta, extractEnvironment, extractErrorClass, extractFrames } from "../analysis/error-logs.js";
import { DEFECT_FORMATS } from "../catalog/defects.js";
import { toolJson, toolText, truncateLog } from "../format/result.js";
import { stripAnsi, titleCase } from "../format/text.js";
import { validateArgs } from "../validation.js";

/** Renders the defect as Jira wiki markup, ready to paste into a ticket. */
function renderJiraReport(defect) {
  const lines = [];
  const env = defect.environment.detected;
  const envRows = Object.entries(env).map(([k, v]) => `| ${titleCase(k)} | ${v} |`);

  lines.push(
    `h2. ${defect.title}`,
    "",
    `*Defect ID:* ${defect.defectId}`,
    `*Severity:* ${defect.severity.toUpperCase()}`,
    `*Category:* ${defect.category}`,
    `*Component:* ${defect.component ?? "unassigned"}`,
    `*Reproducibility:* ${defect.reproducibility}`,
    `*Status:* ${defect.status}`,
    `*Parser confidence:* ${defect.confidence}`,
    "",
    "h3. Environment",
    ""
  );

  if (envRows.length) {
    lines.push("|| Field || Value ||", ...envRows);
  } else {
    lines.push("{panel:bgColor=#fffae6}No environment details were present in the supplied logs.{panel}");
  }
  if (defect.environment.note) {
    lines.push("", `{color:#de350b}*Missing:* ${defect.environment.note}{color}`);
  }

  lines.push(
    "",
    "h3. Pre-conditions",
    "",
    ...defect.preConditions.map((c) => `* ${c}`),
    "",
    "h3. Steps to Reproduce",
    "",
    ...defect.stepsToReproduce.map((s) => `# ${s}`),
    "",
    "h3. Expected Result",
    "",
    defect.assertionDelta?.expected
      ? defect.assertionDelta.expected
      : "The operation completes without error and the documented outcome is produced.",
    "",
    "h3. Actual Result",
    "",
    defect.assertionDelta?.received
      ? defect.assertionDelta.received
      : `${defect.errorClass}: ${defect.errorMessage ?? "see raw output below"}`,
    ""
  );

  if (defect.impactedSegments.length) {
    lines.push(
      "h3. Impacted Code",
      "",
      "|| File || Line || Symbol || Application Code ||",
      ...defect.impactedSegments
        .slice(0, 10)
        .map((s) => `| ${s.file} | ${s.line ?? "-"} | ${s.symbol} | ${s.isApplicationCode ? "yes" : "dependency"} |`),
      ""
    );
  }

  lines.push(
    "h3. Suggested Fix Vectors",
    "",
    ...defect.suggestedFixVectors.map((v) => `* ${v}`),
    "",
    "h3. Regression Coverage",
    "",
    ...defect.regressionTests.map((v) => `* ${v}`),
    "",
    "h3. Evidence Required",
    "",
    ...defect.evidenceRequired.map((v) => `* (/) ${v}`),
    "",
    "h3. Raw Output",
    "",
    "{code}",
    defect.rawExcerpt,
    "{code}"
  );

  return lines.join("\n");
}


function handleParseErrorLogs(args) {
  const { rawLogs, format } = validateArgs(args, {
    rawLogs: { required: true, preserveWhitespace: true },
    format: { required: false, enum: DEFECT_FORMATS, default: "json", maxLength: 16 },
  });

  const logs = stripAnsi(rawLogs);
  const { errorClass, errorMessage } = extractErrorClass(logs);
  const frames = extractFrames(logs);
  const language = detectLanguage(logs);
  const { category, severity } = classifyError(logs, errorClass);
  const assertionDelta = extractAssertionDelta(logs);

  // Stateless and deterministic: the same trace always yields the same id.
  const fingerprint = createHash("sha1")
    .update(`${errorClass ?? "unknown"}|${errorMessage ?? ""}|${frames[0]?.file ?? ""}|${frames[0]?.line ?? ""}`)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();

  const applicationFrames = frames.filter((f) => f.isApplicationCode);
  const likelyOrigin = applicationFrames[0] ?? frames[0] ?? null;

  let confidence = "low";
  if (errorClass && frames.length > 0) confidence = "high";
  else if (errorClass || frames.length > 0) confidence = "medium";

  const defect = {
    defectId: `DEF-${fingerprint}`,
    title: errorClass
      ? `${errorClass}: ${(errorMessage ?? "").slice(0, 120)}`.trim()
      : "Unclassified failure in captured output",
    errorClass: errorClass ?? "Unknown",
    errorMessage: errorMessage ?? null,
    category,
    severity,
    confidence,
    language,
    stepsToReproduce: buildReproSteps(logs, frames, category),
    impactedSegments: frames.map((f) => ({
      file: f.file,
      line: f.line,
      column: f.column,
      symbol: f.symbol,
      isApplicationCode: f.isApplicationCode,
    })),
    likelyOrigin: likelyOrigin
      ? {
          file: likelyOrigin.file,
          line: likelyOrigin.line,
          symbol: likelyOrigin.symbol,
          rationale: likelyOrigin.isApplicationCode
            ? "First stack frame resolving to application code rather than a dependency."
            : "No application frame present; this is the topmost frame available.",
        }
      : null,
    assertionDelta,
    component: deriveComponent(likelyOrigin),
    reproducibility: "Unconfirmed — re-run the exact steps above and record Always / Intermittent (n of 10) / Once",
    status: "New",
    environment: extractEnvironment(logs),
    suggestedFixVectors: buildFixVectors(logs, errorClass),
    regressionTests: [
      likelyOrigin
        ? `Add a unit test pinning the failing input at ${likelyOrigin.file}:${likelyOrigin.line}.`
        : "Add a unit test reproducing the failing input.",
      `Add a negative-path case covering the ${category} partition so this cannot regress silently.`,
    ],
    rawExcerpt: truncateLog(logs, 20, 20).trim().slice(0, 2000),
  };

  defect.preConditions = buildPreConditions(defect);
  defect.evidenceRequired = buildEvidenceList(category);

  if (confidence === "low") {
    defect.parserNote =
      "No recognised error class or stack frame was found. This is a partial record — supply the full stack trace for a complete analysis.";
  }

  if (format === "jira") return toolText(renderJiraReport(defect));
  if (format === "both") {
    return toolText(
      [
        renderJiraReport(defect),
        "",
        "---",
        "",
        "h3. Machine-readable record",
        "",
        "{code:json}",
        JSON.stringify(defect, null, 2),
        "{code}",
      ].join("\n")
    );
  }
  return toolJson(defect);
}

export {
  handleParseErrorLogs,
};
