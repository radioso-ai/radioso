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

/**
 * Places an item dated by ISO `dateFrom`/`dateTo` against a range. An item with one date is
 * that single day, and an inverted pair is read as the span between its two dates, matching
 * how the structured lookup compares chunk dates. An undated item has no position.
 */
export const positionInDateRange = (
  item: { dateFrom?: string; dateTo?: string },
  range: RequestedDateRange,
): DateRangePosition | undefined => {
  // ISO dates order as strings.
  const dates = [item.dateFrom, item.dateTo]
    .filter((date): date is string => typeof date === "string" && date.length > 0)
    .sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (first === undefined || last === undefined) {
    return undefined;
  }
  if (last < range.dateFrom) {
    return "before";
  }
  if (first > range.dateTo) {
    return "after";
  }
  return "within";
};
