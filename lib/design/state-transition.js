/**
 * State transition modelling and lockout threshold transitions
 * (Senior-QA-Engineer.md section 5).
 */

import { padCell, renderTable } from "../format/text.js";

const STATE_VOCAB = [
  "draft", "pending", "active", "inactive", "enabled", "disabled", "locked",
  "unlocked", "approved", "rejected", "published", "archived", "open", "closed",
  "expired", "cancelled", "canceled", "completed", "failed", "suspended",
  "blocked", "verified", "unverified", "paid", "unpaid", "shipped", "delivered",
  "returned", "processing", "queued", "running", "trialing", "past_due",
];

function detectStates(source, parameters) {
  const found = new Set();

  for (const word of STATE_VOCAB) {
    if (new RegExp(`\\b${word}\\b`, "i").test(source)) found.add(word.toLowerCase());
  }
  for (const param of parameters) {
    if (!/state|status|phase|stage/i.test(param.name)) continue;
    for (const member of param.constraints.enum ?? []) found.add(String(member).toLowerCase());
  }
  return [...found].slice(0, 8);
}

/** Canonical event verb that drives a system into each known state. */
const STATE_EVENT_VERBS = {
  draft: "saveDraft", pending: "submit", active: "activate", inactive: "deactivate",
  enabled: "enable", disabled: "disable", locked: "lock", unlocked: "unlock",
  approved: "approve", rejected: "reject", published: "publish", archived: "archive",
  open: "open", closed: "close", expired: "expire", cancelled: "cancel",
  canceled: "cancel", completed: "complete", failed: "fail", suspended: "suspend",
  blocked: "block", verified: "verify", unverified: "revokeVerification",
  paid: "pay", unpaid: "voidPayment", shipped: "ship", delivered: "deliver",
  returned: "return", processing: "process", queued: "enqueue", running: "start",
  trialing: "startTrial", past_due: "missPayment",
};

function detectEvents(parameters, states = []) {
  const events = new Set();
  for (const param of parameters) {
    const match = param.origin.match(/^(?:function|arrow|method|def)\s+(\w+)/);
    if (match) events.add(match[1]);
  }
  for (const state of states) {
    const verb = STATE_EVENT_VERBS[state];
    if (verb) events.add(verb);
  }
  if (events.size === 0) ["submit", "approve", "cancel", "retry"].forEach((e) => events.add(e));
  return [...events].slice(0, 6);
}

/**
 * Finds a bounded failure counter such as failed-login attempts.
 * Deliberately excludes generic "count" names: seatCount is a quantity, not a
 * lockout counter, and treating it as one produces a nonsensical state model.
 */
const LOCKOUT_COUNTER = /attempt|retry|retries|failure|failed|tries|strike|lockout/i;

function findThresholdCounter(parameters) {
  return parameters.find(
    (p) =>
      p.type === "number" &&
      LOCKOUT_COUNTER.test(p.name) &&
      typeof p.constraints.max === "number"
  );
}

function buildStateTransition(source, parameters, moduleInfo) {
  const states = detectStates(source, parameters);
  const counter = findThresholdCounter(parameters);
  if (states.length < 2 && !counter) return null;

  const sections = [];

  if (states.length >= 2) {
    const events = detectEvents(parameters, states);
    sections.push(
      `Detected states : ${states.join(", ")}`,
      `Detected events : ${events.join(", ")}`,
      "",
      "Transition matrix — fill each cell with the resulting state, or ILLEGAL if the",
      "transition must be refused. Every ILLEGAL cell becomes a negative test case.",
      "",
      renderTable(
        ["Current State", ...events],
        states.map((s) => [s, ...events.map(() => "?")])
      ),
      "",
      "Mandatory negative coverage:",
      ...states.map(
        (s) =>
          `  - From "${s}", attempt every event marked ILLEGAL and assert the state is unchanged and an error is surfaced.`
      )
    );
  }

  if (counter) {
    const max = counter.constraints.max;
    if (sections.length) sections.push("");
    sections.push(
      `Threshold transition — ${counter.name} (max ${max}):`,
      ...[
        [max - 1, "remain in the permissive state; the action still succeeds."],
        [max, "transition to the restricted state on this attempt."],
        [max + 1, "remain restricted; confirm no double penalty is applied."],
      ].map(([value, outcome]) => {
        const width = String(max + 1).length;
        return `  - ${counter.name} = ${padCell(String(value), width)} : ${outcome}`;
      }),
      `  - After a successful action, confirm ${counter.name} resets to its initial value.`,
      "  - Confirm the restricted state survives a session restart (it must not be client-side only)."
    );
  }

  return sections.join("\n");
}

export {
  buildStateTransition,
};
