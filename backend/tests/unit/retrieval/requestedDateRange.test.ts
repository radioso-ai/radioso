import { describe, expect, it } from "vitest";

import {
  parseRequestedDateRange,
  positionInDateRange,
  requestedDateRangeDays,
} from "../../../src/modules/retrieval/domain/temporal/requestedDateRange.js";
import { RETRIEVAL_BEHAVIOR } from "../../../src/shared/domain/behaviorConfig.js";

describe("parseRequestedDateRange", () => {
  it("keeps an inclusive ISO range", () => {
    expect(parseRequestedDateRange({ dateFrom: "2026-12-07", dateTo: "2026-12-13" })).toEqual({
      dateFrom: "2026-12-07",
      dateTo: "2026-12-13",
    });
  });

  it("keeps a single day", () => {
    expect(parseRequestedDateRange({ dateFrom: "2027-03-01", dateTo: "2027-03-01" })).toEqual({
      dateFrom: "2027-03-01",
      dateTo: "2027-03-01",
    });
  });

  it("keeps a whole leap year, the longest range a question needs", () => {
    expect(parseRequestedDateRange({ dateFrom: "2028-01-01", dateTo: "2028-12-31" })).toEqual({
      dateFrom: "2028-01-01",
      dateTo: "2028-12-31",
    });
  });

  it.each([
    ["no range", null],
    ["a missing range", undefined],
    ["a string", "2026-12-07/2026-12-13"],
    ["a missing end", { dateFrom: "2026-12-07" }],
    ["a missing start", { dateTo: "2026-12-13" }],
    ["a non-ISO date", { dateFrom: "07/12/2026", dateTo: "2026-12-13" }],
    ["a timestamp instead of a date", { dateFrom: "2026-12-07T00:00:00Z", dateTo: "2026-12-13" }],
    ["an impossible calendar date", { dateFrom: "2026-02-30", dateTo: "2026-03-02" }],
    ["a start after the end", { dateFrom: "2026-12-13", dateTo: "2026-12-07" }],
    ["a range longer than the maximum span", { dateFrom: "2026-01-01", dateTo: "2027-01-02" }],
  ])("drops %s", (_label, value) => {
    expect(parseRequestedDateRange(value)).toBeUndefined();
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
