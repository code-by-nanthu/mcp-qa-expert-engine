/**
 * Contextual edge cases, environment setup, and exit criteria for manual testing.
 */

const CONTEXTUAL_EDGE_CASES = [
  "Double-click the primary submit control rapidly — confirm exactly one record is created.",
  "Submit, then press the browser Back button and resubmit — confirm no duplicate and no stale state.",
  "Refresh the page mid-flow — confirm partially entered data is either preserved or cleanly discarded.",
  "Paste a multi-paragraph block into every short text input — confirm graceful truncation or a clear limit message.",
  "Paste emoji, right-to-left script, and accented characters — confirm storage and redisplay are byte-accurate.",
  "Disconnect the network immediately after submitting — confirm the user is told, and the server state matches the UI.",
  "Change the interface language mid-flow — confirm no untranslated strings and no lost input.",
  "Change the device timezone and repeat a date-sensitive step — confirm no off-by-one-day error.",
  "Open the same record in two tabs and save from both — confirm the lost-update conflict is detected or prevented.",
  "Let the session expire mid-flow, then act — confirm a clean re-authentication without data loss.",
  "Zoom the browser to 200% — confirm no content is lost and no horizontal scrolling appears.",
  "Navigate the entire flow with the keyboard only — confirm every control is reachable and operable.",
];


const ENVIRONMENT_SETUP = [
  "Test account provisioned at the required entitlement level (free / paid / admin).",
  "Seed data created: at least one empty-state record and one fully-populated record.",
  "Edge-state fixtures seeded (expired card, suspended account, maximum-size collection).",
  "Browser and version recorded; cache and cookies cleared before the first run.",
  "Device, OS, and screen resolution recorded.",
  "Network profile selected (fast 3G throttling for at least one pass).",
  "Feature flags confirmed in the intended state for this build.",
  "Build number and environment URL recorded for the test report.",
];


const EXIT_CRITERIA = [
  "All planned scripted cases executed; none left in Not Run.",
  "Zero open Critical or High defects in the feature under test.",
  "Every failed case has a logged defect with full reproduction evidence.",
  "All exploratory charters completed and debriefed.",
  "Regression pass completed on the surrounding module (defect clustering: bugs cluster where bugs were found).",
  "Pass rate and defect density recorded in the Test Summary Report.",
  "Known limitations and deferred defects documented and accepted by the product owner.",
];

export {
  CONTEXTUAL_EDGE_CASES,
  ENVIRONMENT_SETUP,
  EXIT_CRITERIA,
};
