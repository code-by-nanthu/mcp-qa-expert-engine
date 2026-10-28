/**
 * Risk weighting for user flows. A write that moves money outranks a read.
 */

/**
 * Risk weighting. A write that moves money outranks a read of the same data,
 * so mutation is scored separately from subject matter. "email" is deliberately
 * absent from the messaging signal: it appears as a credential far more often
 * than as an outbound notification.
 */
const RISK_SIGNALS = [
  { re: /pay|checkout|billing|card|invoice|refund|subscription|price|charge/i, weight: 5, reason: "handles money" },
  { re: /login|signup|sign up|auth|password|session|token|mfa|2fa|credential/i, weight: 5, reason: "controls account access" },
  { re: /delete|remove|destroy|cancel|terminate|close account/i, weight: 4, reason: "irreversible action" },
  { re: /permission|role|admin|grant|revoke|share|invite/i, weight: 4, reason: "authorisation boundary" },
  { re: /\b(add|adds|create|creates|update|updates|edit|edits|save|saves|submit|submits|pay|pays|purchase|invite|invites|upgrade|downgrade)\b/i, weight: 3, reason: "writes state" },
  { re: /upload|import|attachment/i, weight: 3, reason: "ingests external files" },
  { re: /address|personal|profile|gdpr|consent|privacy|pii/i, weight: 3, reason: "personal data" },
  { re: /download|export|print/i, weight: 2, reason: "data egress" },
  { re: /search|filter|sort|paginat/i, weight: 2, reason: "data-heavy interaction" },
  { re: /notif|sms|alert|reminder/i, weight: 2, reason: "outbound messaging" },
];


function scoreFlowRisk(flow) {
  const reasons = [];
  let score = 1;
  for (const signal of RISK_SIGNALS) {
    if (signal.re.test(flow)) {
      score += signal.weight;
      reasons.push(signal.reason);
    }
  }
  return { flow, score, reasons: reasons.length ? reasons : ["standard interaction"] };
}

export {
  scoreFlowRisk,
};
