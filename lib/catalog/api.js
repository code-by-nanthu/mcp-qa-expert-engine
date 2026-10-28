/**
 * HTTP status contracts per verb and universal API contract rules.
 */

const API_FRAMEWORKS = ["supertest", "playwright", "pytest"];


/** Status contract per HTTP verb: [code, condition]. */
const STATUS_CONTRACT = {
  GET: [
    ["200", "a valid request returns the documented representation"],
    ["400", "a malformed query parameter is rejected"],
    ["401", "a request without credentials is rejected"],
    ["403", "a caller without entitlement is rejected"],
    ["404", "an unknown identifier returns not-found, not an empty 200"],
    ["429", "requests beyond the rate limit are throttled with Retry-After"],
  ],
  POST: [
    ["201", "a valid payload creates the resource and returns its location"],
    ["400", "a missing required field is rejected with a field-level error"],
    ["401", "a request without credentials is rejected"],
    ["403", "a caller without entitlement is rejected"],
    ["409", "a duplicate creation is rejected rather than silently overwriting"],
    ["422", "a semantically invalid payload is rejected"],
  ],
  PUT: [
    ["200", "a valid replacement returns the updated representation"],
    ["400", "a malformed payload is rejected"],
    ["401", "a request without credentials is rejected"],
    ["403", "a caller without entitlement is rejected"],
    ["404", "updating an unknown identifier returns not-found"],
    ["409", "a stale version or ETag mismatch is rejected"],
  ],
  PATCH: [
    ["200", "a valid partial update returns the updated representation"],
    ["400", "an unknown or malformed field is rejected"],
    ["401", "a request without credentials is rejected"],
    ["403", "a caller without entitlement is rejected"],
    ["404", "patching an unknown identifier returns not-found"],
    ["422", "a semantically invalid value is rejected"],
  ],
  DELETE: [
    ["204", "a valid deletion returns no content"],
    ["401", "a request without credentials is rejected"],
    ["403", "a caller without entitlement is rejected"],
    ["404", "deleting an unknown identifier returns not-found"],
    ["409", "deletion blocked by a dependency is rejected with an explanation"],
  ],
};


const UNIVERSAL_CONTRACTS = [
  "Response Content-Type is application/json with an explicit charset.",
  "Error responses share one envelope shape across every status code.",
  "No stack trace, SQL fragment, or internal path appears in any error body.",
  "Unknown request fields are either rejected or ignored — consistently, and documented.",
  "The same request issued twice produces the documented idempotency behaviour.",
  "Timestamps are ISO 8601 with an explicit timezone offset.",
  "Numeric identifiers are returned as strings if they can exceed 2^53.",
  "CORS headers match the documented allowed origins.",
  "Response time stays within the agreed budget under nominal load.",
];

export {
  API_FRAMEWORKS,
  STATUS_CONTRACT,
  UNIVERSAL_CONTRACTS,
};
