import { RETRIEVAL_BEHAVIOR } from "../../../../shared/domain/behaviorConfig.js";

/**
 * The inclusive calendar-date range a question asks about, as ISO `YYYY-MM-DD` dates. The
 * query rewrite resolves it from the question against today's date; code never reads dates
 * out of the question text.
 */
export interface RequestedDateRange {
  dateFrom: string;
  dateTo: string;
}

/** Where a dated item falls relative to a date range. */
type DateRangePosition = "within" | "before" | "after";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const epochMs = (date: string): number => Date.parse(`${date}T00:00:00.000Z`);

// A strict ISO calendar date that round-trips through UTC, so `2026-02-30` is no date.
const isIsoCalendarDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = epochMs(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
};

/** The structured rewrite fields a reading fills: the kept range, or why the model's range was dropped. */
export const requestedDateRangeFields = (reading: RequestedDateRangeReading): {
  requestedDateRange?: RequestedDateRange;
  requestedDateRangeDropReason?: RequestedDateRangeDropReason;
} => ({
  ...(reading.range ? { requestedDateRange: reading.range } : {}),
  ...(!reading.range && reading.dropReason ? { requestedDateRangeDropReason: reading.dropReason } : {}),
});

/** The number of calendar days a range covers, counting both ends. */
export const requestedDateRangeDays = (range: RequestedDateRange): number =>
  Math.round((epochMs(range.dateTo) - epochMs(range.dateFrom)) / DAY_MS) + 1;

/** Why a model-returned range was set aside. Content-free, so traces and telemetry may carry it. */
export type RequestedDateRangeDropReason = "invalid" | "too_long";

/** A model-returned range read: the range kept, the reason it was dropped, or neither for none. */
interface RequestedDateRangeReading {
  range?: RequestedDateRange;
  dropReason?: RequestedDateRangeDropReason;
}

/**
 * Reads a model-returned range, or drops it. A range is kept only when both ends are real
 * ISO calendar dates, the start is not after the end, and it spans at most
 * `RETRIEVAL_BEHAVIOR.temporal.requestedDateRangeMaxDays` days. A malformed or runaway range
 * leaves the turn on its ordinary temporal handling instead of failing it; `null` or an absent
 * value is no range at all.
 */
export const readRequestedDateRange = (value: unknown): RequestedDateRangeReading => {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value !== "object") {
    return { dropReason: "invalid" };
  }
  const { dateFrom, dateTo } = value as { dateFrom?: unknown; dateTo?: unknown };
  if (!isIsoCalendarDate(dateFrom) || !isIsoCalendarDate(dateTo) || dateFrom > dateTo) {
    return { dropReason: "invalid" };
  }
  const range = { dateFrom, dateTo };
  return requestedDateRangeDays(range) <= RETRIEVAL_BEHAVIOR.temporal.requestedDateRangeMaxDays
    ? { range }
    : { dropReason: "too_long" };
};

/** The ISO calendar dates in a chunk's `dateFrom`/`dateTo` metadata; any other value is absent. */
export const datesFromMetadata = (
  metadata: Record<string, unknown> | undefined,
): { dateFrom?: string; dateTo?: string } => {
  const isoDate = (value: unknown): string | undefined => {
    const date = typeof value === "string" ? value.slice(0, 10) : undefined;
    return isIsoCalendarDate(date) ? date : undefined;
  };
  const dateFrom = isoDate(metadata?.dateFrom);
  const dateTo = isoDate(metadata?.dateTo);
  return { ...(dateFrom ? { dateFrom } : {}), ...(dateTo ? { dateTo } : {}) };
};

/**
 * How a dated item's span sits against a range, with the whole days that place it: how long
 * before the range an item begins or ends, and how long after it an item begins or ends.
 */
export type DateRangeRelation =
  | { kind: "entirely_before"; endsDaysBefore: number }
  | { kind: "entirely_after"; beginsDaysAfter: number }
  | { kind: "inside" }
  | { kind: "begins_before_ends_inside"; beginsDaysBefore: number }
  | { kind: "begins_inside_ends_after"; endsDaysAfter: number }
  | { kind: "spans_range"; beginsDaysBefore: number; endsDaysAfter: number };

/** A dated item's span, first day first (the same day twice for a single-day item), and its relation to a range. */
export interface DatedItemRelation {
  span: { dateFrom: string; dateTo: string };
  relation: DateRangeRelation;
}

// An item with one date is that single day, and an inverted pair is the span between its two
// dates, matching how the structured lookup compares chunk dates. ISO dates order as strings.
const datedSpan = (item: { dateFrom?: string; dateTo?: string }): { dateFrom: string; dateTo: string } | undefined => {
  const dates = [item.dateFrom, item.dateTo]
    .filter((date): date is string => typeof date === "string" && date.length > 0)
    .sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  return first === undefined || last === undefined ? undefined : { dateFrom: first, dateTo: last };
};

const daysBetween = (earlier: string, later: string): number =>
  Math.round((epochMs(later) - epochMs(earlier)) / DAY_MS);

const relationOfSpan = (span: { dateFrom: string; dateTo: string }, range: RequestedDateRange): DateRangeRelation => {
  if (span.dateTo < range.dateFrom) {
    return { kind: "entirely_before", endsDaysBefore: daysBetween(span.dateTo, range.dateFrom) };
  }
  if (span.dateFrom > range.dateTo) {
    return { kind: "entirely_after", beginsDaysAfter: daysBetween(range.dateTo, span.dateFrom) };
  }
  const beginsBefore = span.dateFrom < range.dateFrom;
  const endsAfter = span.dateTo > range.dateTo;
  if (beginsBefore && endsAfter) {
    return {
      kind: "spans_range",
      beginsDaysBefore: daysBetween(span.dateFrom, range.dateFrom),
      endsDaysAfter: daysBetween(range.dateTo, span.dateTo),
    };
  }
  if (beginsBefore) {
    return { kind: "begins_before_ends_inside", beginsDaysBefore: daysBetween(span.dateFrom, range.dateFrom) };
  }
  if (endsAfter) {
    return { kind: "begins_inside_ends_after", endsDaysAfter: daysBetween(range.dateTo, span.dateTo) };
  }
  return { kind: "inside" };
};

/**
 * Relates an item dated by ISO `dateFrom`/`dateTo` to a range: whether it begins and ends
 * before, inside, or after it, and by how many days. An item with one date is that single day,
 * and an inverted pair is read as the span between its two dates. An undated item has no
 * relation.
 */
export const relationToDateRange = (
  item: { dateFrom?: string; dateTo?: string },
  range: RequestedDateRange,
): DatedItemRelation | undefined => {
  const span = datedSpan(item);
  return span ? { span, relation: relationOfSpan(span, range) } : undefined;
};

/**
 * Places an item dated by ISO `dateFrom`/`dateTo` against a range: `within` for any item that
 * overlaps it, a multi-day item crossing an edge included. An item with one date is that single
 * day, and an inverted pair is read as the span between its two dates, matching how the
 * structured lookup compares chunk dates. An undated item has no position.
 */
export const positionInDateRange = (
  item: { dateFrom?: string; dateTo?: string },
  range: RequestedDateRange,
): DateRangePosition | undefined => {
  const span = datedSpan(item);
  if (span === undefined) {
    return undefined;
  }
  if (span.dateTo < range.dateFrom) {
    return "before";
  }
  if (span.dateFrom > range.dateTo) {
    return "after";
  }
  return "within";
};
