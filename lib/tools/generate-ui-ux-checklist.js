/**
 * generate-ui-ux-checklist — see the tool it backs.
 */

import { extractUserFlows } from "../analysis/flows.js";
import { scoreFlowRisk } from "../analysis/risk.js";
import { BROWSER_ENGINES, UI_STATES, UX_METRICS, VIEWPORTS, WCAG_CHECKS } from "../catalog/ui.js";
import { toolText } from "../format/result.js";
import { renderTable } from "../format/text.js";
import { validateArgs } from "../validation.js";

function handleGenerateUiUxChecklist(args) {
  const { requirements, scope } = validateArgs(args, {
    requirements: { required: true, preserveWhitespace: true },
    scope: { required: false, enum: ["full", "responsive", "accessibility", "ux"], default: "full", maxLength: 32 },
  });

  const flows = extractUserFlows(requirements);
  const ranked = flows.map(scoreFlowRisk).sort((a, b) => b.score - a.score);
  const topRisk = ranked.slice(0, 3);

  const sections = [
    "=== UI / UX AUDIT CHECKLIST ===",
    `[Scope]          ${scope}`,
    `[Input Size]     ${requirements.length} characters`,
    `[Flows Detected] ${flows.length}`,
  ];

  const wantsAll = scope === "full";

  if (wantsAll || scope === "responsive") {
    sections.push(
      "",
      "--- RESPONSIVE VIEWPORT MATRIX ---",
      "Resize to each width and confirm no clipped text, distorted grid, horizontal",
      "scrollbar, or overlapping control. Test one pixel either side of each breakpoint.",
      "",
      renderTable(
        ["Viewport", "Width", "Height", "Watch For"],
        VIEWPORTS.map((v) => [v.label, `${v.width}px`, `${v.height}px`, v.notes])
      ),
      "",
      "Per-viewport checks:",
      "  [ ] No horizontal page scroll at any width.",
      "  [ ] Tap targets ≥ 44x44px on touch viewports.",
      "  [ ] Text reflows rather than truncating; no mid-word clipping.",
      "  [ ] Images and media scale with max-width:100% and keep aspect ratio.",
      "  [ ] Sticky headers and footers do not occlude content or the primary action.",
      "  [ ] Modals and dropdowns remain fully on-screen and scrollable.",
      "  [ ] Landscape orientation on mobile does not break the layout."
    );

    sections.push(
      "",
      "--- CROSS-BROWSER RENDERING MATRIX ---",
      renderTable(
        ["Engine", "Browsers", "Known Risk Areas"],
        BROWSER_ENGINES.map((b) => [b.engine, b.browsers, b.risks])
      )
    );
  }

  if (wantsAll || scope === "responsive") {
    sections.push(
      "",
      "--- VISUAL REGRESSION TARGETS ---",
      "Capture a baseline per target per viewport. Flag any pixel delta for review.",
      "",
      ...topRisk.map((r, i) => `  VRT-${String(i + 1).padStart(2, "0")}  ${r.flow}`),
      "",
      "  [ ] Baselines captured on a pinned browser version (versions change rendering).",
      "  [ ] Dynamic regions (timestamps, avatars, carousels) masked before comparison.",
      "  [ ] Animations disabled or settled before capture to avoid false positives.",
      "  [ ] Components also captured in isolation (Storybook) to localise failures.",
      "  [ ] Both light and dark themes captured where supported."
    );
  }

  if (wantsAll || scope !== "responsive") {
    sections.push(
      "",
      "--- INTERACTIVE COMPONENT STATES ---",
      "Verify every interactive element in each state below.",
      "",
      renderTable(["State", "Verification"], UI_STATES.map((s) => [s.state, s.verify]))
    );
  }

  if (wantsAll || scope === "accessibility") {
    sections.push(
      "",
      "--- ACCESSIBILITY (WCAG 2.1 AA) ---",
      renderTable(
        ["Criterion", "Level", "Check"],
        WCAG_CHECKS.map((c) => [c.criterion, c.level, c.check])
      ),
      "",
      "Automated scanning covers roughly a third of these. Run axe-core in the E2E suite",
      "(see generate_automation_script), then verify the remainder manually with a",
      "keyboard and a screen reader."
    );
  }

  if (wantsAll || scope === "ux") {
    sections.push(
      "",
      "--- UX USABILITY METRICS ---",
      renderTable(
        ["Metric", "Target", "Method"],
        UX_METRICS.map((m) => [m.metric, m.target, m.method])
      ),
      "",
      "--- OBSERVATION PROTOCOL ---",
      "  [ ] Thinking Aloud: ask the participant to narrate expectations and confusion.",
      "  [ ] Do not assist until the participant is genuinely stuck; record where that happens.",
      "  [ ] Capture session replays and heatmaps to corroborate self-reported friction.",
      "  [ ] Note emotional friction (sighs, hesitation, backtracking) — automation cannot see it."
    );
  }

  sections.push(
    "",
    "--- HIGHEST-RISK FLOWS FOR MANUAL VERIFICATION ---",
    "Ranked by blast radius. Verify these by hand every release, regardless of",
    "automated coverage."
  );

  if (topRisk.length === 0) {
    sections.push(
      "",
      "No discrete user flows could be extracted. Supply a requirements page, a list of",
      "user journeys, or numbered flow steps to obtain a ranked list."
    );
  } else {
    topRisk.forEach((entry, i) => {
      sections.push(
        "",
        `RISK-${String(i + 1).padStart(2, "0")}  (score ${entry.score})  ${entry.flow}`,
        `  Why it ranks  : ${entry.reasons.join("; ")}`,
        "  Manual checks : Happy path end to end; interrupt mid-flow (network drop, back button, refresh);",
        "                  resubmit rapidly; confirm the resulting state in the system of record.",
        "  Evidence      : Screen recording, console log, network waterfall, final persisted state."
      );
    });
  }

  sections.push(
    "",
    "--- SUMMARY ---",
    `Viewports to cover      : ${VIEWPORTS.length}`,
    `Rendering engines       : ${BROWSER_ENGINES.length}`,
    `Component states        : ${UI_STATES.length}`,
    `WCAG criteria           : ${WCAG_CHECKS.length}`,
    `UX metrics              : ${UX_METRICS.length}`,
    `Flows ranked            : ${ranked.length}`,
    `Manual-priority flows   : ${topRisk.length}`
  );

  return toolText(sections.join("\n"));
}

export {
  handleGenerateUiUxChecklist,
};
