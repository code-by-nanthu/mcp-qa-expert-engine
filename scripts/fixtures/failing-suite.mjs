/**
 * Fixture: emulates a test runner that reports failures and exits non-zero.
 * Used by smoke.mjs to prove a failing suite is returned as a readable tool
 * result rather than crashing the protocol stream.
 */
process.stdout.write("Tests: 1 failed, 2 passed, 3 total\n");
process.stderr.write(
  [
    "FAIL src/billing.test.js",
    "  ● billing > applies discount",
    "    TypeError: Cannot read properties of undefined (reading 'rate')",
    "        at applyDiscount (/workspace/src/billing.js:42:19)",
    "        at Object.<anonymous> (/workspace/src/billing.test.js:11:3)",
    "",
  ].join("\n")
);
process.exit(1);
