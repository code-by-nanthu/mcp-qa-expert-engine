/**
 * Viewports, rendering engines, component states, WCAG criteria, and UX metrics.
 */

const VIEWPORTS = [
  { label: "Mobile Portrait (small)", width: 375, height: 667, notes: "iPhone SE / 8 class. Tightest text wrapping budget." },
  { label: "Mobile Portrait (large)", width: 414, height: 896, notes: "iPhone Plus / Max class. Verify safe-area insets." },
  { label: "Tablet Portrait", width: 768, height: 1024, notes: "Common breakpoint boundary — test 767 and 769 either side." },
  { label: "Desktop Base", width: 1280, height: 800, notes: "Most common laptop viewport." },
  { label: "Desktop Wide", width: 1440, height: 900, notes: "Verify max-width containers do not over-stretch." },
  { label: "Desktop Full HD", width: 1920, height: 1080, notes: "Check for excessive whitespace and centred-layout drift." },
];


const BROWSER_ENGINES = [
  { engine: "Blink", browsers: "Chrome, Edge, Opera", risks: "Baseline. Flexbox/grid reference rendering; most permissive." },
  { engine: "WebKit", browsers: "Safari (macOS, iOS)", risks: "Date inputs, backdrop-filter, scroll momentum, 100vh with dynamic toolbars, gap in flexbox on older versions." },
  { engine: "Gecko", browsers: "Firefox", risks: "Scrollbar styling, form control sizing, font smoothing differences." },
];


const UI_STATES = [
  { state: "Default", verify: "Baseline rendering matches the design specification." },
  { state: "Hover", verify: "Affordance changes; must not shift layout. Confirm it is not the only cue (touch devices have no hover)." },
  { state: "Focus", verify: "Visible focus ring meeting 3:1 contrast against adjacent colours; reachable by keyboard Tab in a logical order." },
  { state: "Active / Pressed", verify: "Immediate visual acknowledgement on press before the response returns." },
  { state: "Disabled", verify: "Visually distinct, non-interactive, and announced as disabled to assistive technology." },
  { state: "Loading", verify: "Spinner or skeleton appears within 100ms; control is locked against double submission." },
  { state: "Empty", verify: "Zero-data state explains what is missing and offers the next action." },
  { state: "Error", verify: "Message is specific, adjacent to the offending field, and announced via a live region." },
  { state: "Success", verify: "Confirmation persists long enough to be read and does not rely on colour alone." },
];


const WCAG_CHECKS = [
  { criterion: "1.1.1 Non-text Content", level: "A", check: "Every image, icon button, and chart has a meaningful alt or aria-label; decorative images are alt=\"\"." },
  { criterion: "1.3.1 Info and Relationships", level: "A", check: "Headings are real heading elements in order; form inputs have associated labels; tables use th scope." },
  { criterion: "1.4.3 Contrast (Minimum)", level: "AA", check: "Body text ≥ 4.5:1, large text ≥ 3:1 against its background." },
  { criterion: "1.4.11 Non-text Contrast", level: "AA", check: "Interactive boundaries, focus indicators, and icons ≥ 3:1." },
  { criterion: "1.4.4 Resize Text", level: "AA", check: "Zoom to 200% without loss of content or horizontal scrolling." },
  { criterion: "2.1.1 Keyboard", level: "A", check: "Every control is operable by keyboard alone; no keyboard trap." },
  { criterion: "2.4.3 Focus Order", level: "A", check: "Tab order follows the visual reading order; modals trap and restore focus correctly." },
  { criterion: "2.4.7 Focus Visible", level: "AA", check: "Focus indicator is never suppressed without an equivalent replacement." },
  { criterion: "3.3.1 Error Identification", level: "A", check: "Errors are described in text, not signalled by colour or position alone." },
  { criterion: "4.1.2 Name, Role, Value", level: "A", check: "Custom widgets expose correct role, state, and value to assistive technology." },
];


const UX_METRICS = [
  { metric: "Task Success Rate", target: "≥ 90% unaided completion", method: "Run the flow with 5+ representative users; record completion without help." },
  { metric: "Time on Task", target: "Within the agreed budget for the flow", method: "Time from first interaction to confirmation. Investigate anything over 3 minutes for a checkout-class flow." },
  { metric: "Error Rate", target: "< 1 misstep per task", method: "Count wrong-control clicks, invalid submissions, and backtracks per participant." },
  { metric: "Rage Clicks", target: "Zero", method: "Session replay (Hotjar / Clarity). Repeated clicks on one element indicate an unresponsive or falsely-interactive affordance." },
  { metric: "Scroll Depth", target: "Primary action seen by ≥ 95%", method: "Heatmap. Confirm the primary call to action is discovered without hunting." },
];

export {
  VIEWPORTS,
  BROWSER_ENGINES,
  UI_STATES,
  WCAG_CHECKS,
  UX_METRICS,
};
