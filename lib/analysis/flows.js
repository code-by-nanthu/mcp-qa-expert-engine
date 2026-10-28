/**
 * User-flow and step parsing, action classification, and sample value derivation.
 */

import { MAX_FLOW_STEPS } from "../config.js";
import { camelCase, kebabCase, pascalCase } from "../format/text.js";

const ACTION_RULES = [
  { re: /\b(?:navigat\w*|visit\w*|go(?:es)? to|open\w*|land\w* on|browse\w*)\b/i, action: "navigate" },
  { re: /\b(?:log(?:s|ged)? ?in|sign(?:s|ed)? ?in|authenticat\w*)\b/i, action: "login" },
  { re: /\b(?:log(?:s|ged)? ?out|sign(?:s|ed)? ?out)\b/i, action: "logout" },
  { re: /\b(?:type\w*|enter\w*|fill\w*|input\w*|provid\w*|key\w* in)\b/i, action: "fill" },
  { re: /\b(?:select\w*|choos\w*|pick\w*)\b/i, action: "select" },
  { re: /\b(?:upload\w*|attach\w*)\b/i, action: "upload" },
  { re: /\b(?:check\w* the box|tick\w*|toggl\w*)\b/i, action: "check" },
  { re: /\b(?:verif\w*|assert\w*|confirm\w*|expect\w*|should|validat\w*|see\w*|display\w*)\b/i, action: "assert" },
  { re: /\b(?:click\w*|tap\w*|press\w*|submit\w*|add\w*|save\w*|creat\w*|delet\w*|remov\w*)\b/i, action: "click" },
  { re: /\b(?:wait\w*)\b/i, action: "wait" },
];


const STOPWORDS = new Set([
  "the", "a", "an", "to", "on", "in", "into", "and", "then", "with", "for",
  "of", "at", "user", "users", "page", "screen", "that", "their", "his",
  "her", "its", "is", "are", "be", "has", "have", "valid", "new", "it",
]);


/** Splits a free-form flow description into ordered, de-noised steps. */
function splitFlowSteps(flowDescription) {
  const normalized = flowDescription
    .replace(/\r/g, "")
    .replace(/^\s*\d+[.)]\s*/gm, "\n")
    .replace(/\s*\bthen\b\s*/gi, "\n")
    .replace(/\s*\band then\b\s*/gi, "\n")
    .replace(/[,;]\s*/g, "\n")
    .replace(/^\s*[-*+]\s*/gm, "\n");

  return normalized
    .split("\n")
    .map((s) => s.trim().replace(/^and\s+/i, "").replace(/\.$/, "").trim())
    .filter((s) => s.length > 2)
    .slice(0, MAX_FLOW_STEPS);
}


function detectAction(step) {
  for (const rule of ACTION_RULES) {
    if (rule.re.test(step)) return rule.action;
  }
  return "click";
}


/** Derives a stable element name from the meaningful nouns in a step. */
function deriveTargetName(step, action, index) {
  const words = step
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));

  // Drop the leading verb so "clicks the save button" yields "save button".
  const verbless = words.length > 1 ? words.slice(1) : words;
  const picked = (verbless.length ? verbless : words).slice(0, 3);
  if (picked.length === 0) return `${action}Target${index + 1}`;
  return picked.join(" ");
}


function buildFlowSteps(flowDescription) {
  const raw = splitFlowSteps(flowDescription);
  const source = raw.length > 0 ? raw : [flowDescription];

  return source.map((text, index) => {
    const action = detectAction(text);
    const target = deriveTargetName(text, action, index);
    const slug = kebabCase(target) || `step-${index + 1}`;
    return {
      index: index + 1,
      text,
      action,
      target,
      testId: slug,
      locator: camelCase(target) || `target${index + 1}`,
      method: camelCase(`${action} ${target}`) || `step${index + 1}`,
    };
  });
}


/** Verbs describe the action; the flow is named after what it acts on. */
const ACTION_VERBS = new Set([
  "log", "logs", "logged", "login", "sign", "signs", "visit", "visits", "visited",
  "enter", "enters", "entered", "click", "clicks", "clicked", "tap", "taps",
  "add", "adds", "added", "verify", "verifies", "verified", "navigate", "navigates",
  "open", "opens", "opened", "submit", "submits", "submitted", "select", "selects",
  "type", "types", "typed", "fill", "fills", "filled", "check", "checks", "checked",
  "go", "goes", "went", "see", "sees", "saw", "view", "views", "viewed",
  "upload", "uploads", "download", "downloads", "save", "saves", "create", "creates",
  "update", "updates", "delete", "deletes", "remove", "removes", "search", "searches",
  "confirm", "confirms", "choose", "chooses", "press", "presses", "lands",
]);


function deriveFlowName(flowDescription) {
  const significant = flowDescription
    .replace(/[^A-Za-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w.toLowerCase()));

  const nouns = significant.filter((w) => !ACTION_VERBS.has(w.toLowerCase()));
  const words = (nouns.length ? nouns : significant).slice(0, 3);
  const base = words.length ? words.join(" ") : "Primary Flow";
  return pascalCase(base) || "PrimaryFlow";
}


/** Shared placeholder-value logic so all three emitters stay consistent. */
function sampleValueFor(step) {
  if (/^id$|Id$|uuid|guid/i.test(step.target)) return "11111111-2222-4333-8444-555555555555";
  if (/email/i.test(step.target)) return "qa.user@example.com";
  if (/password/i.test(step.target)) return "Str0ng!Passw0rd";
  if (/card|number/i.test(step.target)) return "4242424242424242";
  if (/cvv|cvc/i.test(step.target)) return "123";
  if (/expiry|expiration|date/i.test(step.target)) return "12/34";
  if (/name/i.test(step.target)) return "QA Automation";
  return `sample ${step.target}`;
}


/** Splits a requirements page or flow description into candidate user flows. */
/** "email (string, required)" declares a field; it is not a user journey. */
const FIELD_DEFINITION = /^[A-Za-z_]\w*\s*[:(]\s*(string|number|boolean|int|integer|float|date|array|object|enum)\b/i;


function extractUserFlows(description) {
  const lines = description
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 8)
    .filter((l) => !FIELD_DEFINITION.test(l))
    .filter((l) => !/^#{1,6}\s/.test(l));

  const flows = lines.length > 0 ? lines : splitFlowSteps(description);
  return flows.slice(0, 12);
}


/* ──────────────────────────────────────────────────────────────────────────
 * Tool 4 extensions: data-driven, responsive, UI states, VRT, a11y, BDD
 * (Senior-QA-Engineer.md section 3; UI-Testing.md sections 1-2)
 * ────────────────────────────────────────────────────────────────────────── */

/** Picks the steps that take a value, for data-driven and Gherkin generation. */
function valueSteps(steps) {
  return steps.filter((s) => s.action === "fill" || s.action === "select");
}

export {
  buildFlowSteps,
  deriveFlowName,
  sampleValueFor,
  extractUserFlows,
  valueSteps,
};
