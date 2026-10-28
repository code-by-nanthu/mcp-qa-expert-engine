/**
 * Error signatures, fix vectors, and evidence requirements.
 */

const ERROR_SIGNATURES = [
  { re: /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT)\b/, category: "network", severity: "high" },
  { re: /\b(MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b|Cannot find module/i, category: "dependency", severity: "high" },
  { re: /\bERR_REQUIRE_ESM\b|Must use import to load ES Module/i, category: "dependency", severity: "high" },
  { re: /\b(EACCES|EPERM)\b|permission denied/i, category: "permission", severity: "high" },
  { re: /JavaScript heap out of memory|OutOfMemoryError|MemoryError/i, category: "resource", severity: "critical" },
  { re: /Segmentation fault|SIGSEGV|core dumped/i, category: "resource", severity: "critical" },
  { re: /\b(SyntaxError|IndentationError|ParseError)\b|Unexpected token/i, category: "syntax", severity: "high" },
  { re: /\b(AssertionError|expect\(|toBe\(|toEqual\(|assert\.)/, category: "assertion", severity: "medium" },
  { re: /\bTimeout\b.*exceeded|Exceeded timeout of|timed out after/i, category: "timeout", severity: "medium" },
  { re: /status (?:code )?(?:of )?5\d{2}\b|Internal Server Error/i, category: "network", severity: "high" },
  { re: /status (?:code )?(?:of )?4\d{2}\b|Unauthorized|Forbidden|Not Found/i, category: "network", severity: "medium" },
];


const FIX_VECTORS = [
  {
    re: /Cannot read propert(?:y|ies) of (undefined|null)(?: \(reading '([^']+)'\))?/,
    build: (m) => [
      `Guard the access before dereferencing${m[2] ? ` "${m[2]}"` : ""} — use optional chaining or an explicit null check.`,
      `Trace the producer: establish why the upstream value is ${m[1]} instead of a populated object.`,
      "Add a defensive default only after confirming the empty state is legitimate, not a masked bug.",
    ],
  },
  {
    re: /Cannot find module ['"]([^'"]+)['"]|MODULE_NOT_FOUND/,
    build: (m) => [
      m[1] ? `Install or restore the missing dependency "${m[1]}".` : "Install the missing dependency.",
      "Verify the import path casing — case-insensitive macOS filesystems mask this until CI runs on Linux.",
      "Confirm the package is in dependencies, not devDependencies, if it is needed at runtime.",
    ],
  },
  {
    re: /\b(ECONNREFUSED|ENOTFOUND)\b(?:[^\n]*?(\d{2,5}))?/,
    build: (m) => [
      `Confirm the dependent service is listening${m[2] ? ` on port ${m[2]}` : ""} before the suite starts.`,
      "Add a readiness probe or wait-for-port step to the test bootstrap.",
      "Check host resolution and that the test environment points at the right base URL.",
    ],
  },
  {
    re: /\b(ETIMEDOUT|Timeout|timed out)\b/i,
    build: () => [
      "Raise the runner timeout for this spec only, after confirming the operation is genuinely slow rather than hung.",
      "Audit for a missing await — an unresolved promise is the most common cause of a hang.",
      "Replace fixed sleeps with explicit wait-for-condition assertions.",
    ],
  },
  {
    re: /\b(TypeError|ValueError|NullPointerException|AttributeError)\b/,
    build: (m) => [
      `Add a type or null guard at the ${m[1]} origin frame identified below.`,
      "Validate the boundary contract — run generate_qa_matrix on the offending function to cover the null and type-mismatch partitions.",
    ],
  },
  {
    re: /\b(KeyError|IndexError|out of (?:range|bounds))\b/i,
    build: () => [
      "Add a bounds or key-existence check before the lookup.",
      "Cover the empty-collection and off-by-one boundaries with explicit regression tests.",
    ],
  },
  {
    re: /\b(AssertionError)\b|expect\(|Expected:[\s\S]*Received:/,
    build: () => [
      "Compare the Expected vs Received values below and decide whether the assertion or the implementation is wrong.",
      "If the expectation changed intentionally, update the fixture and document the contract change.",
    ],
  },
  {
    re: /\b(SyntaxError|IndentationError)\b|Unexpected token/,
    build: () => [
      "Fix the syntax at the reported file and line.",
      "Confirm the module system matches the file extension (ESM .mjs / type:module vs CJS .cjs).",
    ],
  },
  {
    re: /heap out of memory|OutOfMemoryError/i,
    build: () => [
      "Raise the heap ceiling via NODE_OPTIONS=--max-old-space-size as a stopgap only.",
      "Profile for the real leak — unbounded caches and retained listeners are the usual causes.",
      "Shard the suite so a single worker is not holding the whole fixture set.",
    ],
  },
];


/* ── Defect report enrichment (Manual-Testing.md section 3) ────────────── */

const DEFECT_FORMATS = ["json", "jira", "both"];


const EVIDENCE_BY_CATEGORY = {
  network: ["Network HAR export", "Request/response payload with headers", "Service-side log for the same correlation id"],
  dependency: ["Full install log", "Lockfile diff", "node_modules or site-packages listing for the affected package"],
  permission: ["Effective user and role", "File or resource ownership and mode", "Audit log entry for the denied operation"],
  resource: ["Heap snapshot or memory profile", "Process resource usage over time", "Container memory limit configuration"],
  syntax: ["Offending source file at the reported revision", "Build/transpiler configuration", "Runtime and module-system settings"],
  assertion: ["Full assertion diff (expected vs received)", "Test fixture used", "Screenshot at the point of failure"],
  timeout: ["Timeline of the operation", "Timeout configuration in effect", "Downstream service latency metrics"],
  runtime: ["Complete stack trace", "Input payload that triggered the fault", "Console output immediately before the error"],
  unknown: ["Complete raw log", "Steps the operator performed", "Screenshot or recording of the failure"],
};


const UNIVERSAL_EVIDENCE = [
  "Screenshot or screen recording of the failure",
  "Browser console output",
  "Build number and environment URL",
];

export {
  ERROR_SIGNATURES,
  FIX_VECTORS,
  DEFECT_FORMATS,
  EVIDENCE_BY_CATEGORY,
  UNIVERSAL_EVIDENCE,
};
