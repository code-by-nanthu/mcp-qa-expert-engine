/**
 * Parameter extraction, constraint mining, and type inference from source or requirements.
 */

import { MAX_PARAMETERS } from "../config.js";
import { escapeRegExp, titleCase } from "../format/text.js";

const RESERVED_WORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "const", "let",
  "var", "await", "typeof", "new", "do", "else", "try", "class", "import",
  "export", "throw", "yield", "delete", "void", "in", "of", "case", "default",
  "self", "cls", "this", "super", "constructor", "with", "lambda", "print",
]);


/** Reduces a git diff to its post-change source so parsing sees real code. */
function normalizeSource(input) {
  const lines = input.split("\n");
  const isDiff = lines.some((l) => /^(diff --git |@@ |\+\+\+ |--- )/.test(l));
  if (!isDiff) return { source: input, inputKind: /^\s*[-*#]/m.test(input) ? "requirements" : "source" };

  const kept = [];
  for (const line of lines) {
    if (/^(diff --git |index |@@ |\+\+\+ |--- |new file|deleted file|similarity |rename |Binary files)/.test(line)) continue;
    if (line.startsWith("-")) continue; // removed lines are not the new contract
    kept.push(line.startsWith("+") ? line.slice(1) : line.replace(/^ /, ""));
  }
  return { source: kept.join("\n"), inputKind: "diff" };
}


/** Comma-splits a parameter list without breaking on nested generics or objects. */
function splitParamList(list) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}


function extractParameters(source) {
  const found = new Map();

  const add = (rawName, rawType, origin) => {
    const name = String(rawName).replace(/^\.\.\./, "").replace(/\?$/, "").trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
    if (RESERVED_WORDS.has(name) || RESERVED_WORDS.has(name.toLowerCase())) return;
    if (found.has(name)) {
      const existing = found.get(name);
      if (!existing.rawType && rawType) existing.rawType = rawType.trim();
      return;
    }
    if (found.size >= MAX_PARAMETERS) return;
    found.set(name, { name, rawType: rawType ? rawType.trim() : null, origin });
  };

  const ingestList = (list, origin) => {
    for (const part of splitParamList(list)) {
      // Destructured parameter: { a, b } or [a, b]
      const destructured = part.match(/^[{[]([^}\]]*)[}\]]/);
      if (destructured) {
        for (const inner of splitParamList(destructured[1])) {
          const key = inner.split(/[:=]/)[0].trim();
          add(key, null, `${origin} (destructured)`);
        }
        continue;
      }
      const m = part.match(/^([A-Za-z_$][\w$]*)\s*\??\s*(?::\s*([^=]+?))?\s*(?:=\s*.+)?$/);
      if (m) add(m[1], m[2], origin);
    }
  };

  // JS/TS function declarations and arrow functions.
  for (const m of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([\s\S]*?)\)/g)) {
    ingestList(m[2], `function ${m[1]}()`);
  }
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(([\s\S]*?)\)\s*=>/g)) {
    ingestList(m[2], `arrow ${m[1]}()`);
  }
  // Class / object methods.
  for (const m of source.matchAll(/(?:^|\n)\s*(?:public |private |protected |static |async )*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[\w<>[\]|\s]+)?\s*\{/g)) {
    if (RESERVED_WORDS.has(m[1])) continue;
    ingestList(m[2], `method ${m[1]}()`);
  }
  // Python definitions.
  for (const m of source.matchAll(/def\s+([A-Za-z_]\w*)\s*\(([\s\S]*?)\)\s*(?:->[^:]+)?:/g)) {
    ingestList(m[2], `def ${m[1]}()`);
  }

  // TypeScript interface / type / class field declarations.
  const TYPE_LIKE = /^(['"]|string|number|boolean|bigint|Date|any|unknown|object|symbol|null|undefined|Array|Record|Map|Set|Promise|int|float|str|bool|list|dict|[A-Z]\w*)/;
  for (const m of source.matchAll(/^[ \t]*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\??)\s*:\s*([A-Za-z_$'"][\w$<>[\]|'"., ]*?)\s*[;,]?\s*$/gm)) {
    const rawType = m[3].trim();
    if (!TYPE_LIKE.test(rawType)) continue;
    add(m[1], rawType, "type field");
  }

  // Markdown requirement bullets: "- age (integer, 18-120)" / "- **email**: must be valid"
  const DECLARED_TYPE = /\b(string|number|boolean|int|integer|float|double|decimal|date|datetime|timestamp|array|list|object|enum|uuid|text)\b/i;
  for (const m of source.matchAll(/^\s*[-*+]\s+(?:\*\*)?`?([A-Za-z_][\w]*)`?(?:\*\*)?\s*[:(]\s*(.+)$/gm)) {
    const declared = m[2].match(DECLARED_TYPE);
    add(m[1], declared ? declared[1] : null, "requirement bullet");
  }

  return [...found.values()];
}


/** Collects every line mentioning a parameter so constraints can be mined from it. */
function gatherContext(source, name) {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  return source
    .split("\n")
    .filter((l) => re.test(l))
    .slice(0, 15)
    .join("\n");
}


function extractConstraints(context, rawType) {
  const c = {};
  let m;

  if ((m = context.match(/\bmin(?:imum)?\s*(?:length|len|value|size)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i))) c.min = Number(m[1]);
  if ((m = context.match(/\bmax(?:imum)?\s*(?:length|len|value|size)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i))) c.max = Number(m[1]);
  if ((m = context.match(/\bbetween\s+(-?\d+)\s+and\s+(-?\d+)/i))) { c.min = Number(m[1]); c.max = Number(m[2]); }
  if ((m = context.match(/(-?\d+)\s*(?:-|–|to)\s*(-?\d+)/)) && c.min === undefined) { c.min = Number(m[1]); c.max = Number(m[2]); }
  if ((m = context.match(/>=\s*(-?\d+)/))) c.min = Number(m[1]);
  if ((m = context.match(/<=\s*(-?\d+)/))) c.max = Number(m[1]);
  if ((m = context.match(/>\s*(-?\d+)/)) && c.min === undefined) c.min = Number(m[1]) + 1;
  if ((m = context.match(/<\s*(-?\d+)/)) && c.max === undefined) c.max = Number(m[1]) - 1;
  if ((m = context.match(/\bmaxLength\D{0,5}(\d+)/i))) c.maxLength = Number(m[1]);
  if ((m = context.match(/\bminLength\D{0,5}(\d+)/i))) c.minLength = Number(m[1]);
  if ((m = context.match(/\.length\s*[<>]=?\s*(\d+)/))) c.maxLength = c.maxLength ?? Number(m[1]);
  if ((m = context.match(/\b(\d+)\s*(?:digits|characters|chars)\b/i))) {
    const exact = Number(m[1]);
    c.minLength = c.minLength ?? exact;
    c.maxLength = c.maxLength ?? exact;
  }

  if (/\b(required|mandatory|non-?null|not null|NOT NULL)\b/i.test(context)) c.required = true;
  if (/\b(optional|nullable|may be (?:null|omitted))\b/i.test(context) || /\?\s*:/.test(context)) c.optional = true;

  if ((m = context.match(/\bone of\s*[:\s]\s*([^.\n]+)/i))) {
    c.enum = m[1].split(/[,|/]/).map((s) => s.trim().replace(/^["'`]|["'`]$/g, "")).filter(Boolean).slice(0, 10);
  }
  if (rawType && rawType.includes("|") && /['"]/.test(rawType)) {
    const members = rawType.split("|").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
    if (members.length > 1) c.enum = members.slice(0, 10);
  }
  if (!c.enum) {
    // A quoted union written in a comment or docstring, e.g. 'active' | 'suspended'
    const union = context.match(/(?:['"][^'"\n]+['"]\s*\|\s*)+['"][^'"\n]+['"]/);
    if (union) {
      const members = union[0].split("|").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
      if (members.length > 1) c.enum = members.slice(0, 10);
    }
  }

  return c;
}


function inferType(name, rawType, constraints) {
  if (constraints.enum && constraints.enum.length > 1) return "enum";

  const t = (rawType ?? "").toLowerCase().trim();
  if (t) {
    if (/\[\]|^array|^list|^tuple|^set</.test(t)) return "array";
    if (/^(number|int|integer|float|double|long|decimal|bigint)\b/.test(t)) return "number";
    if (/^(string|str|text|char|uuid)\b/.test(t)) return "string";
    if (/^(bool|boolean)\b/.test(t)) return "boolean";
    if (/^(date|datetime|timestamp)\b/.test(t)) return "date";
    if (/^(object|dict|map|record|any|unknown)\b/.test(t)) return "object";
  }

  const n = name.toLowerCase();
  if (
    /^(is|has|can|should|will|does|did|allow|enable|require|auto|use|show|hide|skip|force|include|exclude|with|only)[A-Z_]/.test(name) ||
    /^(enabled|active|visible|disabled|flag|checked|required|optional)$/.test(n) ||
    /(enabled|disabled|visible|checked|flag)$/.test(n)
  ) return "boolean";
  if (/(count|amount|age|qty|quantity|price|total|index|size|length|num|score|rate|limit|offset|balance|weight|height|percent|retries|retry|attempt|tries|failure|strike|timeout|port|seat|day|week|month|year|level|priority|duration|quota|threshold)/.test(n)) return "number";
  if (/(date|time|expiry|expiration|dob|birthday|createdat|updatedat|deadline)/.test(n)) return "date";
  if (/(list|items|array|rows|records|collection|tags|ids)$/.test(n)) return "array";
  if (/(email|name|title|desc|text|url|token|password|phone|address|code|slug|message|label|path|query|key|id)/.test(n)) return "string";

  // Constraints observed in the source imply a shape even when the name does not.
  if (typeof constraints.min === "number" || typeof constraints.max === "number") return "number";
  if (typeof constraints.minLength === "number" || typeof constraints.maxLength === "number") return "string";
  return "unknown";
}


function describeConstraints(c) {
  const parts = [];
  if (typeof c.min === "number") parts.push(`min=${c.min}`);
  if (typeof c.max === "number") parts.push(`max=${c.max}`);
  if (typeof c.minLength === "number") parts.push(`minLength=${c.minLength}`);
  if (typeof c.maxLength === "number") parts.push(`maxLength=${c.maxLength}`);
  if (c.enum) parts.push(`enum=[${c.enum.join("|")}]`);
  if (c.required) parts.push("required");
  if (c.optional) parts.push("optional");
  return parts.length ? parts.join(", ") : "none declared";
}


/* ── Test case specification (Senior-QA-Engineer.md section 5) ──────────── */

const VERB_PREFIXES =
  /^(create|get|set|update|delete|remove|add|fetch|load|save|validate|handle|process|build|make|run|execute|apply|calculate|compute|check|verify|ensure|is|has|on)/i;


/** Derives a Component/Module label and the TC_<CODE>_NNN id prefix. */
function deriveModuleInfo(parameters) {
  const fnOrigin = parameters
    .map((p) => p.origin)
    .find((o) => /^(function|arrow|method|def) /.test(o));

  const raw = fnOrigin
    ? fnOrigin.replace(/^(function|arrow|method|def)\s+/, "").replace(/\(\)$/, "")
    : null;

  const noun = raw ? raw.replace(VERB_PREFIXES, "") || raw : "Component";
  const label = titleCase(noun) || "Component";
  const code = (noun.replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "COMP").slice(0, 8);
  return { label, code, invocation: raw };
}


function deriveFeatureName(spec) {
  const heading = spec.match(/^\s*#{1,3}\s+(.+)$/m);
  if (heading) return heading[1].trim().slice(0, 80);
  const firstLine = spec.split("\n").map((l) => l.trim()).find((l) => l.length > 3);
  return (firstLine ?? "Feature Under Test").replace(/^[-*+]\s*/, "").slice(0, 80);
}

export {
  normalizeSource,
  extractParameters,
  gatherContext,
  extractConstraints,
  inferType,
  describeConstraints,
  deriveModuleInfo,
  deriveFeatureName,
};
