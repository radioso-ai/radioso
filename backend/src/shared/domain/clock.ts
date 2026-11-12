import { DEFAULT_TIME_ZONE } from "./referenceTimeZone.js";

/** A source of the current time. Injected so time-dependent code stays testable. */
export type Clock = () => Date;

/** Default clock backed by the system wall clock. */
export const systemClock: Clock = () => new Date();

const isoDateUtc = (now: Date): string => {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

// One formatter per zone; the zones reaching here are canonical IANA names, a bounded set.
const calendarDateFormatters = new Map<string, Intl.DateTimeFormat>();

const calendarDateFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = calendarDateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    calendarDateFormatters.set(timeZone, formatter);
  }
  return formatter;
};

/**
 * The calendar date `now` falls on in `timeZone`, as `YYYY-MM-DD`: the reference "today" for
 * prompts, the range lookup, and the `today()` retrieval-settings token, so all of them share
 * one notion of "today" for a turn. UTC when no zone is named, and for a zone `Intl` does not
 * know, so a bad zone never fails a turn.
 */
export const formatIsoDate = (now: Date, timeZone: string = DEFAULT_TIME_ZONE): string => {
  if (timeZone === DEFAULT_TIME_ZONE) return isoDateUtc(now);
  try {
    const parts = calendarDateFormatter(timeZone).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return isoDateUtc(now);
  }
};

// English weekday names: model input for the prompt's date line, not product copy.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * A calendar date, `YYYY-MM-DD`, with its weekday: `2026-10-21 (Wednesday)`. For a date a caller
 * already holds, such as an anchor the provenance records, so the prompt shows exactly that date.
 * Anything that is not a calendar date is returned as given, without a weekday.
 */
export const describeIsoDate = (isoDate: string): string => {
  const weekday = WEEKDAYS[new Date(`${isoDate}T00:00:00.000Z`).getUTCDay()];
  return weekday ? `${isoDate} (${weekday})` : isoDate;
};

/**
 * Today's date in `timeZone` with its weekday, `2026-10-21 (Wednesday)`, for prompts that
 * resolve a period a question names. "This weekend" or "next Friday" is weekday arithmetic, and
 * a planner decoding straight into JSON at low reasoning effort should not have to derive the
 * weekday from the ISO date first.
 */
export const formatPromptDate = (now: Date, timeZone: string = DEFAULT_TIME_ZONE): string =>
  describeIsoDate(formatIsoDate(now, timeZone));

/** As long as the longest date `formatPromptDate` renders, for prompt size estimates. */
export const PROMPT_DATE_BUDGET_STAND_IN = "0000-00-00 (Wednesday)";
