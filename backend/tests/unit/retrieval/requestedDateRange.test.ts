import { describe, expect, it } from "vitest";

import {
  positionInDateRange,
  readRequestedDateRange,
  relationToDateRange,
  requestedDateRangeDays,
} from "../../../src/modules/retrieval/domain/temporal/requestedDateRange.js";
import { RETRIEVAL_BEHAVIOR } from "../../../src/shared/domain/behaviorConfig.js";

describe("readRequestedDateRange", () => {
  it("keeps an inclusive ISO range", () => {
    expect(readRequestedDateRange({ dateFrom: "2026-12-07", dateTo: "2026-12-13" })).toEqual({
      range: { dateFrom: "2026-12-07", dateTo: "2026-12-13" },
    });
  });

  it("keeps a single day", () => {
    expect(readRequestedDateRange({ dateFrom: "2027-03-01", dateTo: "2027-03-01" })).toEqual({
      range: { dateFrom: "2027-03-01", dateTo: "2027-03-01" },
    });
  });

  it("keeps a whole leap year, the longest range a question needs", () => {
    expect(readRequestedDateRange({ dateFrom: "2028-01-01", dateTo: "2028-12-31" })).toEqual({
      range: { dateFrom: "2028-01-01", dateTo: "2028-12-31" },
    });
  });

  it.each([
    ["no range", null],
    ["a missing range", undefined],
  ])("reads %s as no range, with nothing dropped", (_label, value) => {
    expect(readRequestedDateRange(value)).toEqual({});
  });

  it.each([
    ["a string", "2026-12-07/2026-12-13"],
    ["a missing end", { dateFrom: "2026-12-07" }],
    ["a missing start", { dateTo: "2026-12-13" }],
    ["a non-ISO date", { dateFrom: "07/12/2026", dateTo: "2026-12-13" }],
    ["a timestamp instead of a date", { dateFrom: "2026-12-07T00:00:00Z", dateTo: "2026-12-13" }],
    ["an impossible calendar date", { dateFrom: "2026-02-30", dateTo: "2026-03-02" }],
    ["a start after the end", { dateFrom: "2026-12-13", dateTo: "2026-12-07" }],
  ])("drops %s as invalid", (_label, value) => {
    expect(readRequestedDateRange(value)).toEqual({ dropReason: "invalid" });
  });

  it("drops a range longer than the maximum span as too long", () => {
    expect(readRequestedDateRange({ dateFrom: "2026-01-01", dateTo: "2027-01-02" })).toEqual({ dropReason: "too_long" });
  });

  it("bounds the span by the configured maximum", () => {
    expect(RETRIEVAL_BEHAVIOR.temporal.requestedDateRangeMaxDays).toBe(366);
  });
});

describe("requestedDateRangeDays", () => {
  it("counts both ends", () => {
    expect(requestedDateRangeDays({ dateFrom: "2026-12-07", dateTo: "2026-12-13" })).toBe(7);
    expect(requestedDateRangeDays({ dateFrom: "2026-12-07", dateTo: "2026-12-07" })).toBe(1);
  });
});

describe("positionInDateRange", () => {
  const week = { dateFrom: "2026-12-07", dateTo: "2026-12-13" };

  it("places an item that overlaps the range within it, including a multi-day item crossing an edge", () => {
    expect(positionInDateRange({ dateFrom: "2026-12-09", dateTo: "2026-12-09" }, week)).toBe("within");
    expect(positionInDateRange({ dateFrom: "2026-12-05", dateTo: "2026-12-07" }, week)).toBe("within");
    expect(positionInDateRange({ dateFrom: "2026-12-13", dateTo: "2026-12-20" }, week)).toBe("within");
    expect(positionInDateRange({ dateFrom: "2026-11-01", dateTo: "2027-01-31" }, week)).toBe("within");
  });

  it("places items that end before or start after the range outside it", () => {
    expect(positionInDateRange({ dateFrom: "2026-12-01", dateTo: "2026-12-06" }, week)).toBe("before");
    expect(positionInDateRange({ dateFrom: "2026-12-14", dateTo: "2026-12-14" }, week)).toBe("after");
  });

  it("reads an item with one date as that single day and ignores an inverted pair's order", () => {
    expect(positionInDateRange({ dateTo: "2026-12-10" }, week)).toBe("within");
    expect(positionInDateRange({ dateFrom: "2026-12-14" }, week)).toBe("after");
    expect(positionInDateRange({ dateFrom: "2026-12-10", dateTo: "2026-12-05" }, week)).toBe("within");
  });

  it("has no position for an undated item", () => {
    expect(positionInDateRange({}, week)).toBeUndefined();
  });
});

describe("relationToDateRange", () => {
  // Monday 7 to Sunday 13 December 2026.
  const week = { dateFrom: "2026-12-07", dateTo: "2026-12-13" };

  it("places an item that ends before the range entirely before it, counting the days between", () => {
    expect(relationToDateRange({ dateFrom: "2026-12-01", dateTo: "2026-12-05" }, week)).toEqual({
      span: { dateFrom: "2026-12-01", dateTo: "2026-12-05" },
      relation: { kind: "entirely_before", endsDaysBefore: 2 },
    });
    expect(relationToDateRange({ dateFrom: "2026-12-01", dateTo: "2026-12-06" }, week)?.relation)
      .toEqual({ kind: "entirely_before", endsDaysBefore: 1 });
  });

  it("places an item that begins after the range entirely after it, counting the days between", () => {
    expect(relationToDateRange({ dateFrom: "2026-12-14", dateTo: "2026-12-14" }, week)?.relation)
      .toEqual({ kind: "entirely_after", beginsDaysAfter: 1 });
    expect(relationToDateRange({ dateFrom: "2026-12-20", dateTo: "2026-12-22" }, week)?.relation)
      .toEqual({ kind: "entirely_after", beginsDaysAfter: 7 });
  });

  it("places an item that begins and ends within the range inside it, on either edge too", () => {
    for (const item of [
      { dateFrom: "2026-12-07", dateTo: "2026-12-13" },
      { dateFrom: "2026-12-09", dateTo: "2026-12-11" },
      { dateFrom: "2026-12-07", dateTo: "2026-12-07" },
      { dateFrom: "2026-12-13", dateTo: "2026-12-13" },
    ]) {
      expect(relationToDateRange(item, week)?.relation).toEqual({ kind: "inside" });
    }
  });

  it("places an item that begins before the range and ends in it as beginning before, by how many days", () => {
    expect(relationToDateRange({ dateFrom: "2026-12-06", dateTo: "2026-12-13" }, week)).toEqual({
      span: { dateFrom: "2026-12-06", dateTo: "2026-12-13" },
      relation: { kind: "begins_before_ends_inside", beginsDaysBefore: 1 },
    });
    expect(relationToDateRange({ dateFrom: "2026-12-01", dateTo: "2026-12-07" }, week)?.relation)
      .toEqual({ kind: "begins_before_ends_inside", beginsDaysBefore: 6 });
  });

  it("places an item that begins in the range and ends after it as ending after, by how many days", () => {
    expect(relationToDateRange({ dateFrom: "2026-12-13", dateTo: "2026-12-20" }, week)?.relation)
      .toEqual({ kind: "begins_inside_ends_after", endsDaysAfter: 7 });
    expect(relationToDateRange({ dateFrom: "2026-12-07", dateTo: "2026-12-14" }, week)?.relation)
      .toEqual({ kind: "begins_inside_ends_after", endsDaysAfter: 1 });
  });

  it("places an item that begins before the range and ends after it as spanning it, across a year end", () => {
    expect(relationToDateRange({ dateFrom: "2026-11-01", dateTo: "2027-01-31" }, week)?.relation)
      .toEqual({ kind: "spans_range", beginsDaysBefore: 36, endsDaysAfter: 49 });
    expect(relationToDateRange({ dateFrom: "2026-12-06", dateTo: "2026-12-14" }, week)?.relation)
      .toEqual({ kind: "spans_range", beginsDaysBefore: 1, endsDaysAfter: 1 });
  });

  it("places items against a single-day range", () => {
    const day = { dateFrom: "2026-12-07", dateTo: "2026-12-07" };

    expect(relationToDateRange({ dateFrom: "2026-12-07", dateTo: "2026-12-07" }, day)?.relation).toEqual({ kind: "inside" });
    expect(relationToDateRange({ dateFrom: "2026-12-06", dateTo: "2026-12-07" }, day)?.relation)
      .toEqual({ kind: "begins_before_ends_inside", beginsDaysBefore: 1 });
    expect(relationToDateRange({ dateFrom: "2026-12-06", dateTo: "2026-12-08" }, day)?.relation)
      .toEqual({ kind: "spans_range", beginsDaysBefore: 1, endsDaysAfter: 1 });
  });

  it("reads an item with one date as that single day", () => {
    expect(relationToDateRange({ dateTo: "2026-12-10" }, week)).toEqual({
      span: { dateFrom: "2026-12-10", dateTo: "2026-12-10" },
      relation: { kind: "inside" },
    });
    expect(relationToDateRange({ dateFrom: "2026-12-14" }, week)).toEqual({
      span: { dateFrom: "2026-12-14", dateTo: "2026-12-14" },
      relation: { kind: "entirely_after", beginsDaysAfter: 1 },
    });
  });

  it("reads an inverted pair as the span between its two dates", () => {
    expect(relationToDateRange({ dateFrom: "2026-12-10", dateTo: "2026-12-05" }, week)).toEqual({
      span: { dateFrom: "2026-12-05", dateTo: "2026-12-10" },
      relation: { kind: "begins_before_ends_inside", beginsDaysBefore: 2 },
    });
  });

  it("has no relation for an undated item", () => {
    expect(relationToDateRange({}, week)).toBeUndefined();
  });

  it("agrees with positionInDateRange: every relation but entirely before or after overlaps the range", () => {
    const items = [
      { dateFrom: "2026-12-01", dateTo: "2026-12-06" },
      { dateFrom: "2026-12-06", dateTo: "2026-12-07" },
      { dateFrom: "2026-12-09" },
      { dateFrom: "2026-12-13", dateTo: "2026-12-14" },
      { dateFrom: "2026-11-01", dateTo: "2027-01-31" },
      { dateTo: "2026-12-14" },
    ];
    for (const item of items) {
      const kind = relationToDateRange(item, week)?.relation.kind;
      const expected = kind === "entirely_before" ? "before" : kind === "entirely_after" ? "after" : "within";
      expect(positionInDateRange(item, week)).toBe(expected);
    }
  });
});
