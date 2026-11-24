// Runtime values of the `declare`d consts and functions index.d.ts exports; everything else in the contract is types only.

export const REPLY_OUTCOMES = Object.freeze(["answered", "no_context", "out_of_scope", "unavailable"]);

export const REPLY_GROUNDINGS = Object.freeze(["grounded", "ungrounded", "not_applicable", "unknown"]);

export const REPLY_COVERAGES = Object.freeze(["answered", "partial", "unanswered", "unclear", "unavailable", "not_assessed"]);

export const REDACTED_VALUE = "[redacted]";

export const redactSensitiveValues = (values, sensitiveKeys) => {
  const sensitive = new Set(sensitiveKeys);
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, sensitive.has(key) ? REDACTED_VALUE : value]),
  );
};

// ISO calendar date (YYYY-MM-DD). Protocol syntax, not a keyword list.
const ISO_CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

// `Date.UTC` reads a year from 0 to 99 as 1900 to 1999, so such a date never round-trips and is
// refused; no date a visitor or a host gives falls there.
export const isIsoCalendarDate = (value) => {
  const match = ISO_CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

export const ROUTINE_ITEM_VALUE_LIMITS = Object.freeze({ key: 128, title: 160, link: 2048, fields: 12, fieldKey: 64, fieldValue: 200 });

export const readableSlotValue = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  typeof value.key === "string" && typeof value.title === "string"
    ? value.title
    : value;

const renderedValue = (value) => JSON.stringify(value) ?? "null";

const labelled = (name, entry, typeLabel) =>
  `${name}${entry.description ? ` — ${entry.description}` : ""} (${typeLabel})`;

const renderListLines = (name, entry, value) => {
  const fields = Object.entries(entry.fields);
  const fieldLabels = fields.map(([fieldName, field]) => labelled(fieldName, field, field.type)).join(", ");
  if (!Array.isArray(value) || value.length === 0) {
    return [`${labelled(name, entry, "list")}: not returned`];
  }
  const items = value.map((item, index) => {
    const record = item !== null && typeof item === "object" ? item : {};
    const parts = fields
      .filter(([fieldName]) => Object.hasOwn(record, fieldName))
      .map(([fieldName]) => `${fieldName}: ${renderedValue(record[fieldName])}`);
    return `  ${index + 1}. ${parts.join("; ")}`;
  });
  return [`${labelled(name, entry, `list of ${value.length}; fields: ${fieldLabels}`)}:`, ...items];
};

export const renderSkillOutputLines = (outputs, contract) => {
  const lines = [];
  for (const [name, entry] of Object.entries(contract)) {
    const present = Object.hasOwn(outputs, name);
    if (entry.type === "list") {
      lines.push(...renderListLines(name, entry, present ? outputs[name] : undefined));
    } else {
      lines.push(`${labelled(name, entry, entry.type)}: ${present ? renderedValue(outputs[name]) : "not returned"}`);
    }
  }
  for (const [name, value] of Object.entries(outputs)) {
    if (!Object.hasOwn(contract, name)) lines.push(`${name}: ${renderedValue(value)}`);
  }
  return lines;
};
