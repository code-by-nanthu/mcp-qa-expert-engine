/**
 * Pure string and table helpers. No I/O, no domain knowledge.
 */

function titleCase(value) {
  return value
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}


function pascalCase(value) {
  return titleCase(value).replace(/[^A-Za-z0-9]/g, "");
}


function kebabCase(value) {
  return titleCase(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}


function camelCase(value) {
  const pascal = pascalCase(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}


function padCell(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}


function renderTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length))
  );
  const line = (cells) => "| " + cells.map((c, i) => padCell(c, widths[i])).join(" | ") + " |";
  const divider = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
  return [line(headers), divider, ...rows.map((r) => line(r))].join("\n");
}


function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/** Strips ANSI colour codes so pattern matching is not defeated by formatting. */
const ANSI_PATTERN = new RegExp("\\u001b\\[[0-9;]*[A-Za-z]", "g");

function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, "");
}

export {
  titleCase,
  pascalCase,
  kebabCase,
  camelCase,
  padCell,
  renderTable,
  escapeRegExp,
  stripAnsi,
};
