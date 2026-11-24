import type { SkillDataValueType } from "@radioso/conversation-contract";

/** The value types a skill's declared input or output carries: the routine slot types without `item`. */
export const skillDataValueTypes = ["text", "number", "boolean", "date", "email"] as const satisfies readonly SkillDataValueType[];

/** Inputs normalize a date to the calendar day; outputs keep the time a source returned. */
type SkillValueDirection = "input" | "output";

type SkillValueCoercion = { ok: true; value: string | number | boolean } | { ok: false };

// Structural format checks, not product vocabulary. The email and decimal rules are the ones the
// routine slot check applies (conversation-engine `checkSlotValue`); a test pins the agreement.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u;
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/u;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ISO_DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/iu;

const accepted = (value: string | number | boolean): SkillValueCoercion => ({ ok: true, value });
const refused: SkillValueCoercion = { ok: false };

const isCalendarDate = (value: string): boolean => {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const coerceDate = (value: string, direction: SkillValueDirection): SkillValueCoercion => {
  if (isCalendarDate(value)) return accepted(value);
  const match = ISO_DATE_TIME_PATTERN.exec(value);
  if (!match || !isCalendarDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) {
    return refused;
  }
  if (direction === "input") return accepted(match[1]);
  // A date-time without a zone names no instant, so it is kept as the source wrote it.
  if (!match[5]) return accepted(value);
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? refused : accepted(instant.toISOString());
};

const coerceText = (type: SkillDataValueType, value: string, direction: SkillValueDirection): SkillValueCoercion => {
  switch (type) {
    case "text":
      return accepted(value);
    case "email":
      return EMAIL_PATTERN.test(value) ? accepted(value) : refused;
    case "number": {
      // A decimal too long for a double reads as Infinity, which is no number.
      const number = DECIMAL_PATTERN.test(value) ? Number(value) : Number.NaN;
      return Number.isFinite(number) ? accepted(number) : refused;
    }
    case "boolean": {
      const lowered = value.toLowerCase();
      return lowered === "true" || lowered === "false" ? accepted(lowered === "true") : refused;
    }
    case "date":
      return coerceDate(value, direction);
  }
};

/**
 * One value in its declared type's canonical form: text as written (a finite number or boolean
 * stated as text), a number from a number or a plain decimal, a boolean from a boolean or
 * `true`/`false`, a date as an ISO date (inputs) or ISO date or date-time (outputs), an email
 * trimmed. Null, undefined, blank text, objects and arrays fit no type.
 */
export const coerceSkillValue = (
  type: SkillDataValueType,
  value: unknown,
  direction: SkillValueDirection,
): SkillValueCoercion => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return refused;
    return coerceText(type, type === "text" ? value : trimmed, direction);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return refused;
    return type === "number" ? accepted(value) : type === "text" ? accepted(String(value)) : refused;
  }
  if (typeof value === "boolean") {
    return type === "boolean" ? accepted(value) : type === "text" ? accepted(String(value)) : refused;
  }
  return refused;
};
