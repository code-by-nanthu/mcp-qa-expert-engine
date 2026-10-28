/**
 * Stack trace parsing, error classification, and environment extraction.
 */

import { ERROR_SIGNATURES, EVIDENCE_BY_CATEGORY, FIX_VECTORS, UNIVERSAL_EVIDENCE } from "../catalog/defects.js";
import { titleCase } from "../format/text.js";

function detectLanguage(logs) {
  if (/Traceback \(most recent call last\)|File "[^"]+", line \d+/.test(logs)) return "python";
  if (/\bat [\w.$]+\([\w$]+\.java:\d+\)|java\.lang\./.test(logs)) return "java";
  if (/\bat .*\(?(?:\/|[A-Za-z]:\\|https?:\/\/).*:\d+:\d+\)?/.test(logs)) return "javascript";
  if (/goroutine \d+ \[|^panic:/m.test(logs)) return "go";
  if (/thread '.*' panicked at/.test(logs)) return "rust";
  return "unknown";
}


function extractErrorClass(logs) {
  const candidates = [
    /^\s*(?:Uncaught\s+)?([A-Z][\w.]*(?:Error|Exception))\s*:\s*(.+)$/m,
    /^([a-z][\w.]*\.[A-Z]\w*(?:Error|Exception))\s*:\s*(.+)$/m,
    /^\s*(panic)\s*:\s*(.+)$/m,
    /\b(E[A-Z]{4,})\b[:\s]+(.*)$/m,
  ];
  for (const re of candidates) {
    const match = logs.match(re);
    if (match) {
      return { errorClass: match[1].trim(), errorMessage: match[2].trim().slice(0, 500) };
    }
  }
  // Jest/Vitest assertion blocks carry no classic error class.
  if (/expect\(|Expected:[\s\S]*Received:/.test(logs)) {
    const line = logs.split("\n").find((l) => /expect\(|✕|FAIL/.test(l));
    return {
      errorClass: "AssertionError",
      errorMessage: (line ?? "Assertion failed").trim().slice(0, 500),
    };
  }
  return { errorClass: null, errorMessage: null };
}


const APP_CODE_EXCLUSIONS = /node_modules|\/internal\/|^node:|site-packages|\/usr\/lib|<anonymous>/;


function extractFrames(logs) {
  const frames = [];
  const seen = new Set();

  const push = (frame) => {
    const key = `${frame.file}:${frame.line}:${frame.column ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    frames.push(frame);
  };

  // JavaScript / TypeScript: "at fn (/path/file.js:12:5)" or "at /path/file.js:12:5"
  const jsFrame = /\bat\s+(?:(?:async\s+)?([\w.$<>[\]\s]+?)\s+)?\(?((?:[A-Za-z]:\\|\/|\.{1,2}\/|https?:\/\/|node:|webpack:)[^\s)]+?):(\d+):(\d+)\)?/g;
  for (const m of logs.matchAll(jsFrame)) {
    push({
      symbol: (m[1] || "<anonymous>").trim(),
      file: m[2],
      line: Number(m[3]),
      column: Number(m[4]),
      isApplicationCode: !APP_CODE_EXCLUSIONS.test(m[2]),
    });
  }

  // Python: '  File "/path/x.py", line 12, in fn'
  const pyFrame = /File "([^"]+)", line (\d+)(?:, in (\S+))?/g;
  for (const m of logs.matchAll(pyFrame)) {
    push({
      symbol: m[3] || "<module>",
      file: m[1],
      line: Number(m[2]),
      column: null,
      isApplicationCode: !APP_CODE_EXCLUSIONS.test(m[1]),
    });
  }

  // Java: "at com.acme.Thing.method(Thing.java:12)"
  const javaFrame = /\bat\s+([\w.$]+)\(([\w$]+\.java):(\d+)\)/g;
  for (const m of logs.matchAll(javaFrame)) {
    push({
      symbol: m[1],
      file: m[2],
      line: Number(m[3]),
      column: null,
      isApplicationCode: !/^(java|javax|jdk|sun)\./.test(m[1]),
    });
  }

  return frames.slice(0, 25);
}


function extractAssertionDelta(logs) {
  const expected = logs.match(/^\s*(?:Expected|expected)(?: value)?:?\s*(.+)$/m);
  const received = logs.match(/^\s*(?:Received|received|Actual|actual):?\s*(.+)$/m);
  if (!expected && !received) return null;
  return {
    expected: expected ? expected[1].trim().slice(0, 300) : null,
    received: received ? received[1].trim().slice(0, 300) : null,
  };
}


function classifyError(logs, errorClass) {
  for (const sig of ERROR_SIGNATURES) {
    if (sig.re.test(logs)) return { category: sig.category, severity: sig.severity };
  }
  if (errorClass) return { category: "runtime", severity: "high" };
  return { category: "unknown", severity: "medium" };
}


function buildFixVectors(logs, errorClass) {
  const vectors = [];
  for (const entry of FIX_VECTORS) {
    const match = logs.match(entry.re);
    if (match) vectors.push(...entry.build(match));
    if (vectors.length >= 6) break;
  }
  if (vectors.length === 0) {
    vectors.push(
      errorClass
        ? `Locate the first application frame below and inspect the state feeding into the ${errorClass}.`
        : "No recognised error signature. Re-run the suite with verbose logging to capture a full stack trace."
    );
  }
  return vectors.slice(0, 6);
}


function buildReproSteps(logs, frames, category) {
  const steps = [];
  const commandHint = logs.match(
    /^\s*[$>]\s*((?:npm|npx|yarn|pnpm|pytest|jest|vitest|mocha|playwright)[^\n]*)$/m
  );

  steps.push(
    commandHint
      ? `Run "${commandHint[1].trim()}" from the workspace root.`
      : "Run the failing test suite from the workspace root."
  );

  const origin = frames.find((f) => f.isApplicationCode) ?? frames[0];
  if (origin) {
    steps.push(`Exercise the code path reaching ${origin.symbol} at ${origin.file}:${origin.line}.`);
  }
  if (category === "network") {
    steps.push("Ensure the dependent service/API is reachable from the test environment.");
  }
  if (category === "dependency") {
    steps.push("Reproduce against a clean install to confirm it is not stale local state.");
  }
  steps.push("Observe the error reproduced in the captured output below.");
  return steps;
}


/** Pulls environment facts out of the log text; reports what is missing. */
function extractEnvironment(logs) {
  const env = {};

  let m;
  if ((m = logs.match(/\bNode(?:\.js)?\s+v?(\d+\.\d+\.\d+)/i))) env.runtime = `Node.js ${m[1]}`;
  else if ((m = logs.match(/\bv(\d+\.\d+\.\d+)\b/)) && /node/i.test(logs)) env.runtime = `Node.js ${m[1]}`;
  if ((m = logs.match(/\bPython\s+(\d+\.\d+(?:\.\d+)?)/i))) env.runtime = `Python ${m[1]}`;
  if ((m = logs.match(/\bjava version "?(\d+[\d._]*)/i))) env.runtime = `Java ${m[1]}`;

  if ((m = logs.match(/(Chrome|Firefox|Safari|Edge|Edg|OPR)\/(\d+[\d.]*)/))) {
    const name = m[1] === "Edg" ? "Edge" : m[1] === "OPR" ? "Opera" : m[1];
    env.browser = `${name} ${m[2]}`;
  }
  if ((m = logs.match(/Mozilla\/5\.0 \(([^)]+)\)/))) env.userAgentPlatform = m[1];

  if (/\bdarwin\b|Mac OS X|macOS/i.test(logs)) env.os = "macOS";
  else if (/\bwin32\b|Windows NT/i.test(logs)) env.os = "Windows";
  else if (/\blinux\b|Ubuntu|Debian|Alpine/i.test(logs)) env.os = "Linux";

  if ((m = logs.match(/\b(\d{3,4})\s*[x×]\s*(\d{3,4})\b/))) env.viewport = `${m[1]}x${m[2]}`;
  if ((m = logs.match(/https?:\/\/[^\s"')]+/))) env.url = m[0].slice(0, 200);
  if ((m = logs.match(/\bCI[=:]\s*(true|1)\b/i))) env.ci = true;

  const required = ["browser", "os", "viewport", "url", "runtime"];
  const missing = required.filter((k) => !(k in env));

  return {
    detected: env,
    missing,
    note: missing.length
      ? `Not present in the supplied logs: ${missing.join(", ")}. Capture these manually — a defect without environment specs is not reproducible.`
      : null,
  };
}


/** Best-effort component name from the first application frame. */
function deriveComponent(likelyOrigin) {
  if (!likelyOrigin?.file) return null;
  const base = likelyOrigin.file.split(/[/\\]/).filter(Boolean).pop() ?? "";
  const stem = base.replace(/\.(js|jsx|ts|tsx|mjs|cjs|py|java|go|rb|php)$/i, "");
  return stem ? titleCase(stem) : null;
}


function buildPreConditions(defect) {
  const conditions = ["Application is running at the build and environment recorded below"];
  if (defect.likelyOrigin) {
    conditions.push(`Execution reaches ${defect.likelyOrigin.symbol} in ${defect.likelyOrigin.file}`);
  }
  switch (defect.category) {
    case "network":
      conditions.push("Dependent service is reachable (or deliberately unavailable, if that is the trigger)");
      break;
    case "permission":
      conditions.push("Caller is authenticated with the role stated in the report");
      break;
    case "dependency":
      conditions.push("Dependencies installed from the committed lockfile");
      break;
    case "assertion":
      conditions.push("Test fixture and seed data are in the documented state");
      break;
    default:
      conditions.push("Input data matching the payload in Steps to Reproduce is present");
      break;
  }
  return conditions;
}


function buildEvidenceList(category) {
  return [...(EVIDENCE_BY_CATEGORY[category] ?? EVIDENCE_BY_CATEGORY.unknown), ...UNIVERSAL_EVIDENCE];
}

export {
  detectLanguage,
  extractErrorClass,
  extractFrames,
  extractAssertionDelta,
  classifyError,
  buildFixVectors,
  buildReproSteps,
  extractEnvironment,
  deriveComponent,
  buildPreConditions,
  buildEvidenceList,
};
