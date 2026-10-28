/**
 * Boundary Value Analysis vectors and Equivalence Partitioning buckets.
 */

/** Format-aware extra vectors for well-known semantic field names. */
function formatVectors(name) {
  const n = name.toLowerCase();
  if (/email/.test(n)) {
    return [
      ['"user@example.com"', "format (valid)", "Accept"],
      ['"user@@example.com"', "format (double @)", "Reject"],
      ['"user@example"', "format (no TLD)", "Reject"],
      ['"@example.com"', "format (no local part)", "Reject"],
      ['"user+tag@example.co.uk"', "format (plus addressing)", "Accept: RFC-valid"],
    ];
  }
  if (/url|uri|endpoint/.test(n)) {
    return [
      ['"https://example.com/path"', "format (valid https)", "Accept"],
      ['"javascript:alert(1)"', "format (dangerous scheme)", "Reject"],
      ['"//example.com"', "format (protocol-relative)", "Reject or normalise explicitly"],
    ];
  }
  if (/password/.test(n)) {
    return [
      ['"Str0ng!Passw0rd"', "format (meets policy)", "Accept"],
      ['"password"', "format (common/weak)", "Reject per password policy"],
      ['" leading space"', "format (whitespace)", "Define trim policy explicitly"],
    ];
  }
  if (/phone|mobile/.test(n)) {
    return [
      ['"+447700900123"', "format (E.164)", "Accept"],
      ['"07700 900123"', "format (national, spaces)", "Normalise or reject explicitly"],
      ['"123"', "format (too short)", "Reject"],
    ];
  }
  return [];
}


function buildBvaVectors(param) {
  const { type, constraints: c, name } = param;
  const vectors = [];
  const push = (input, classification, expected) => vectors.push({ input, classification, expected });
  const nullExpect = c.optional ? "Accept: documented as optional" : "Reject: not documented as nullable";
  const undefExpect = c.required ? "Reject: parameter is required" : "Apply documented default";

  switch (type) {
    case "number": {
      if (typeof c.min === "number") {
        push(String(c.min - 1), "lower boundary (min - 1)", "Reject: below minimum");
        push(String(c.min), "lower boundary (min)", "Accept: minimum is inclusive");
        push(String(c.min + 1), "lower boundary (min + 1)", "Accept");
      } else {
        push("0", "lower boundary (zero)", "Define behaviour: zero may be valid or a sentinel");
        push("-1", "lower boundary (negative)", "Reject unless negatives are specified");
      }
      if (typeof c.max === "number") {
        push(String(c.max - 1), "upper boundary (max - 1)", "Accept");
        push(String(c.max), "upper boundary (max)", "Accept: maximum is inclusive");
        push(String(c.max + 1), "upper boundary (max + 1)", "Reject: exceeds maximum");
      } else {
        push("2147483647", "upper boundary (int32 max)", "Accept or reject explicitly — no silent overflow");
        push("9007199254740991", "upper boundary (MAX_SAFE_INTEGER)", "Accept");
        push("9007199254740992", "upper boundary (beyond safe integer range)", "Reject: precision loss");
      }
      push("1.5", "precision (fractional)", "Reject if the contract is integer-only");
      push("NaN", "type violation", "Reject");
      push("Infinity", "type violation", "Reject");
      push('"42"', "type violation (numeric string)", "Reject or coerce — behaviour must be explicit");
      break;
    }

    case "string": {
      const min = c.minLength ?? c.min;
      const max = c.maxLength ?? c.max;
      push('""', "lower boundary (empty string)", c.required ? "Reject: required field" : "Accept as empty");
      push('"a"', "lower boundary (single character)", "Accept");
      if (typeof min === "number" && min > 1) {
        push(`<string of length ${min - 1}>`, "lower boundary (minLength - 1)", "Reject: below minimum length");
        push(`<string of length ${min}>`, "lower boundary (minLength)", "Accept");
      }
      if (typeof max === "number") {
        push(`<string of length ${max - 1}>`, "upper boundary (maxLength - 1)", "Accept");
        push(`<string of length ${max}>`, "upper boundary (maxLength)", "Accept: limit is inclusive");
        push(`<string of length ${max + 1}>`, "upper boundary (maxLength + 1)", "Reject: exceeds maximum length");
      } else {
        push("<string of length 255>", "upper boundary (common column limit)", "Accept or reject explicitly");
        push("<string of length 65536>", "upper boundary (buffer stress)", "Reject gracefully — no truncation, no crash");
      }
      push('"   "', "whitespace only", "Reject if trimmed content is required");
      push('" value "', "leading/trailing whitespace", "Define trim policy explicitly");
      push('"日本語 🚀 Ωmega"', "unicode / multibyte", "Accept: no mojibake, correct length accounting");
      push(`"' OR 1=1 --"`, "injection payload (SQL)", "Treat as literal data — parameterised query");
      push('"<script>alert(1)</script>"', "injection payload (XSS)", "Escape on output — stored safely");
      for (const [input, classification, expected] of formatVectors(name)) {
        push(input, classification, expected);
      }
      break;
    }

    case "boolean": {
      push("true", "valid partition", "Accept");
      push("false", "valid partition", "Accept — must not be treated as missing");
      push('"true"', "type violation (string)", "Reject or coerce explicitly");
      push('"false"', "type violation (truthy string)", "Reject: a non-empty string is truthy");
      push("0", "type violation (falsy number)", "Reject");
      push("1", "type violation (truthy number)", "Reject");
      push('""', "type violation (falsy string)", "Reject");
      break;
    }

    case "enum": {
      for (const member of c.enum) {
        push(JSON.stringify(member), "valid partition (member)", "Accept");
      }
      const first = c.enum[0] ?? "value";
      push(JSON.stringify(String(first).toUpperCase()), "case variation", "Reject or normalise explicitly");
      push('"__unknown__"', "invalid partition (non-member)", "Reject");
      push('""', "invalid partition (empty)", "Reject");
      push("0", "type violation (ordinal index)", "Reject: members are not positional");
      break;
    }

    case "array": {
      const max = c.maxLength ?? c.max;
      push("[]", "lower boundary (empty collection)", c.required ? "Reject if at least one element is required" : "Accept");
      push("[<1 element>]", "lower boundary (single element)", "Accept");
      if (typeof max === "number") {
        push(`[<${max} elements>]`, "upper boundary (max)", "Accept: limit is inclusive");
        push(`[<${max + 1} elements>]`, "upper boundary (max + 1)", "Reject: exceeds maximum");
      } else {
        push("[<1000 elements>]", "upper boundary (volume)", "Accept or paginate — must not time out");
      }
      push("[null]", "element null-state", "Reject: element contract violated");
      push("[<duplicate elements>]", "duplicate members", "Define uniqueness policy explicitly");
      push('"not-an-array"', "type violation", "Reject");
      push("{}", "type violation (object)", "Reject");
      break;
    }

    case "date": {
      push('"2024-01-15T00:00:00Z"', "valid partition (ISO 8601)", "Accept");
      push('"1970-01-01T00:00:00Z"', "lower boundary (epoch)", "Accept or reject explicitly");
      push('"2024-02-29"', "boundary (leap day, valid)", "Accept");
      push('"2023-02-29"', "boundary (leap day, invalid year)", "Reject");
      push('"2024-03-31T01:30:00"', "boundary (DST transition)", "Resolve unambiguously");
      push('"9999-12-31T23:59:59Z"', "upper boundary (max date)", "Accept or reject explicitly");
      push('"2024-13-01"', "invalid partition (month out of range)", "Reject");
      push('"15/01/2024"', "format ambiguity (DD/MM vs MM/DD)", "Reject or require ISO 8601");
      push('"not-a-date"', "type violation", "Reject");
      break;
    }

    case "object": {
      push("<fully populated object>", "valid partition", "Accept");
      push("{}", "lower boundary (empty object)", c.required ? "Reject: required keys absent" : "Accept");
      push("<object missing a required key>", "invalid partition (incomplete)", "Reject with a field-level error");
      push("<object with an unexpected extra key>", "invalid partition (excess)", "Ignore or reject — must be explicit");
      push("<deeply nested object, depth 50>", "upper boundary (nesting depth)", "Reject gracefully — no stack overflow");
      push('"not-an-object"', "type violation", "Reject");
      break;
    }

    default: {
      push("<typical valid value>", "valid partition (nominal)", "Accept");
      push("<empty value>", "lower boundary", "Define behaviour explicitly");
      push("<maximum supported value>", "upper boundary", "Accept at the limit, reject beyond it");
      push("<value of an unexpected type>", "type violation", "Reject");
      break;
    }
  }

  push("null", "null state", nullExpect);
  push("undefined", "null state (omitted)", undefExpect);
  return vectors;
}


function buildEpBuckets(param) {
  const { type, constraints: c, name } = param;
  const valid = [];
  const invalid = [];

  switch (type) {
    case "number":
      valid.push(
        typeof c.min === "number" && typeof c.max === "number"
          ? `Numbers within [${c.min}, ${c.max}]`
          : "Finite numbers inside the documented operating range"
      );
      if (typeof c.min === "number") invalid.push(`Numbers below ${c.min}`);
      else invalid.push("Negative numbers (unless explicitly supported)");
      if (typeof c.max === "number") invalid.push(`Numbers above ${c.max}`);
      else invalid.push("Numbers beyond MAX_SAFE_INTEGER");
      invalid.push("NaN and Infinity", "Non-numeric types (string, boolean, object, array)");
      break;

    case "string": {
      const max = c.maxLength ?? c.max;
      valid.push(max ? `Non-empty strings of length 1..${max}` : "Non-empty strings within the documented length limit");
      if (/email|url|phone/i.test(name)) valid.push(`Strings matching the documented ${name} format`);
      invalid.push(
        "Empty and whitespace-only strings",
        max ? `Strings longer than ${max} characters` : "Strings exceeding the storage column width",
        "Non-string types",
        "Strings carrying injection payloads (SQL / XSS / path traversal)"
      );
      break;
    }

    case "boolean":
      valid.push("Strict boolean true", "Strict boolean false");
      invalid.push("Truthy/falsy non-booleans (0, 1, \"true\", \"\")", "null / undefined when required");
      break;

    case "enum":
      valid.push(`Declared members: ${c.enum.join(", ")}`);
      invalid.push("Values outside the declared member set", "Case variants of valid members", "Ordinal indices in place of members");
      break;

    case "array": {
      const max = c.maxLength ?? c.max;
      valid.push(max ? `Arrays holding 1..${max} well-formed elements` : "Arrays holding well-formed elements within the documented size limit");
      invalid.push(
        c.required ? "Empty arrays" : "Arrays containing null or malformed elements",
        max ? `Arrays longer than ${max}` : "Arrays large enough to breach the response time budget",
        "Non-array types"
      );
      break;
    }

    case "date":
      valid.push("Valid ISO 8601 timestamps inside the supported calendar range");
      invalid.push("Calendar-impossible dates (2023-02-29, month 13)", "Ambiguous or non-ISO formats", "Non-date types");
      break;

    case "object":
      valid.push("Objects satisfying every required key with correctly typed values");
      invalid.push("Objects missing required keys", "Objects with wrongly typed values", "Non-object types");
      break;

    default:
      valid.push("Values satisfying the documented contract");
      invalid.push("Values violating the documented contract", "Unexpected types");
      break;
  }

  if (c.optional) valid.push("null / omitted (documented as optional)");
  else invalid.push("null / undefined (not documented as nullable)");

  return { valid, invalid };
}

export {
  buildBvaVectors,
  buildEpBuckets,
};
