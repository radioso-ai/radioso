import type { RoutineItemValue, RoutineSlotType, RoutineTraceRejectedSlot } from "@radioso/conversation-contract";
import { ROUTINE_ITEM_VALUE_LIMITS } from "@radioso/conversation-contract";

/**
 * The one structural rule set for a routine slot value against its declared type (#1374).
 * Every path that writes a visitor-given value into routine state — the runner's merge of
 * selector and activator values, and a post-completion correction — checks it here, so a
 * value is kept only when it fits: an email looks like an email, a date is a calendar date.
 *
 * Structural checks only, never English vocabulary: natural language ("yes", "11 November")
 * is turned into the canonical form by the model that extracts it, and anything else is
 * rejected rather than guessed at.
 */

/**
 * Why a value was not accepted. `empty` is "not given" (null, undefined, a blank string)
 * and is dropped without being a rejection; the others are recorded on the routine trace.
 */
type SlotValueRejection = "empty" | RoutineTraceRejectedSlot["reason"];

type SlotValueCheck =
  | { ok: true; value: string | number | boolean | RoutineItemValue }
  | { ok: false; reason: SlotValueRejection };

// Structural format check, not English product vocabulary: a localpart, "@", and a dotted
// domain. Deliberately permissive — the source of truth for deliverability is elsewhere.
// Domain labels are dot-separated with no dots inside a label, so the domain part has exactly
// one parse and the check stays linear on long inputs.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u;
// ISO calendar date (YYYY-MM-DD). Protocol syntax, not a keyword list.
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
// A plain decimal as the model writes a count ("2", "-3.5"); no exponents, radix prefixes, or units.
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/u;

const isIsoCalendarDate = (value: string): boolean => {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
};

const accepted = (value: string | number | boolean | RoutineItemValue): SlotValueCheck => ({ ok: true, value });
const rejected = (reason: SlotValueRejection): SlotValueCheck => ({ ok: false, reason });

/** At most `max` UTF-16 code units, never splitting a surrogate pair. */
const cut = (text: string, max: number): string => {
  if (text.length <= max) {
    return text;
  }
  const end = /[\uD800-\uDBFF]/u.test(text.charAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
};

// An absolute http(s) address, as a stored card's link is. Protocol syntax, not vocabulary.
const isWebAddress = (value: string): boolean => {
  if (value.length > ROUTINE_ITEM_VALUE_LIMITS.link || !/^https?:\/\//iu.test(value)) {
    return false;
  }
  return URL.canParse(value);
};

const isFieldValue = (value: unknown): value is string | number | boolean =>
  (typeof value === "string" && value.length <= ROUTINE_ITEM_VALUE_LIMITS.fieldValue) ||
  (typeof value === "number" && Number.isFinite(value)) ||
  typeof value === "boolean";

/**
 * An `item` value as a pick writes it: a key and a title within the stored card's bounds, an
 * optional web address, and at most twelve scalar fields. Anything else does not fit.
 */
const checkItemObject = (value: object): SlotValueCheck => {
  const { key, title, link, fields } = value as Partial<Record<keyof RoutineItemValue, unknown>>;
  const fieldEntries = fields !== null && typeof fields === "object" && !Array.isArray(fields) ? Object.entries(fields) : null;
  if (
    typeof key !== "string" || key.trim().length === 0 || key.length > ROUTINE_ITEM_VALUE_LIMITS.key ||
    typeof title !== "string" || title.trim().length === 0 || title.length > ROUTINE_ITEM_VALUE_LIMITS.title ||
    (link !== undefined && (typeof link !== "string" || !isWebAddress(link))) ||
    !fieldEntries || fieldEntries.length > ROUTINE_ITEM_VALUE_LIMITS.fields ||
    !fieldEntries.every(([name, entry]) => name.length > 0 && name.length <= ROUTINE_ITEM_VALUE_LIMITS.fieldKey && isFieldValue(entry))
  ) {
    return rejected("type_mismatch");
  }
  return accepted({ key, title, ...(typeof link === "string" ? { link } : {}), fields: Object.fromEntries(fieldEntries) as RoutineItemValue["fields"] });
};

const checkString = (type: RoutineSlotType, value: string): SlotValueCheck => {
  switch (type) {
    case "item":
      // An item the visitor named in text, where no card was picked: its name is all it holds.
      return accepted({ key: cut(value, ROUTINE_ITEM_VALUE_LIMITS.key), title: cut(value, ROUTINE_ITEM_VALUE_LIMITS.title), fields: {} });
    case "text":
      return accepted(value);
    case "email":
      return EMAIL_PATTERN.test(value) ? accepted(value) : rejected("type_mismatch");
    case "date":
      return isIsoCalendarDate(value) ? accepted(value) : rejected("type_mismatch");
    case "number":
      return DECIMAL_PATTERN.test(value) ? accepted(Number(value)) : rejected("type_mismatch");
    case "boolean": {
      // Only the canonical tokens: the extracting model normalizes "sì" or "yes" to them.
      const lowered = value.toLowerCase();
      return lowered === "true" || lowered === "false" ? accepted(lowered === "true") : rejected("type_mismatch");
    }
  }
};

/**
 * Checks one value against a slot's declared type and returns it in that type's canonical
 * form: a trimmed string, a number for a numeric string, a boolean for `true`/`false`. A text
 * slot also takes a finite number or a boolean, stated as text. Objects and arrays fit no type
 * but `item`, which takes the card a pick copies, or a name given in text.
 * Checking an accepted value again returns it unchanged.
 */
export const checkSlotValue = (type: RoutineSlotType, value: unknown): SlotValueCheck => {
  if (value === null || value === undefined) {
    return rejected("empty");
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? rejected("empty") : checkString(type, trimmed);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return rejected("type_mismatch");
    }
    return type === "number" ? accepted(value) : type === "text" ? accepted(String(value)) : rejected("type_mismatch");
  }
  if (typeof value === "boolean") {
    return type === "boolean" ? accepted(value) : type === "text" ? accepted(String(value)) : rejected("type_mismatch");
  }
  if (type === "item" && typeof value === "object" && !Array.isArray(value)) {
    return checkItemObject(value);
  }
  return rejected("not_scalar");
};
