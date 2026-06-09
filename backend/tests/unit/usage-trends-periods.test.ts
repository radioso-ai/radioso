import { describe, expect, it } from "vitest";

import {
  buildUsageTrendBuckets,
  mergeUsageTrendRows,
  normalizeUsageTrendRange,
} from "../../src/modules/reporting/usageTrendsQuery.js";
import type { UsageTrendAggregateRow } from "../../src/modules/reporting/contracts/index.js";

describe("usage trends period helpers", () => {
  it("builds a continuous daily UTC series and merges sparse aggregate rows", () => {
    const range = normalizeUsageTrendRange({
      from: "2026-06-01",
      to: "2026-06-03",
      granularity: "day",
    });

    const buckets = mergeUsageTrendRows(buildUsageTrendBuckets(range), [
      {
        bucket_start: "2026-06-01T00:00:00.000Z",
        conversations_created: "2",
        user_messages: "3",
        assistant_messages: "2",
        input_tokens: "100",
        output_tokens: "50",
        total_tokens: "150",
      },
      {
        bucket_start: "2026-06-03T00:00:00.000Z",
        conversations_created: "1",
        user_messages: "1",
        assistant_messages: "1",
        input_tokens: "20",
        output_tokens: "30",
        total_tokens: "50",
      },
    ] satisfies UsageTrendAggregateRow[]);

    expect(buckets).toEqual([
      {
        periodStart: "2026-06-01T00:00:00.000Z",
        periodEnd: "2026-06-02T00:00:00.000Z",
        conversationsCreated: 2,
        messages: { total: 5, user: 3, assistant: 2 },
        tokens: { input: 100, output: 50, total: 150 },
      },
      {
        periodStart: "2026-06-02T00:00:00.000Z",
        periodEnd: "2026-06-03T00:00:00.000Z",
        conversationsCreated: 0,
        messages: { total: 0, user: 0, assistant: 0 },
        tokens: { input: 0, output: 0, total: 0 },
      },
      {
        periodStart: "2026-06-03T00:00:00.000Z",
        periodEnd: "2026-06-04T00:00:00.000Z",
        conversationsCreated: 1,
        messages: { total: 2, user: 1, assistant: 1 },
        tokens: { input: 20, output: 30, total: 50 },
      },
    ]);
  });

  it("aligns weekly buckets to UTC Monday starts", () => {
    const range = normalizeUsageTrendRange({
      from: "2026-06-03",
      to: "2026-06-16",
      granularity: "week",
    });

    expect(buildUsageTrendBuckets(range).map((bucket) => bucket.periodStart)).toEqual([
      "2026-06-01T00:00:00.000Z",
      "2026-06-08T00:00:00.000Z",
      "2026-06-15T00:00:00.000Z",
    ]);
  });

  it("aligns monthly buckets to UTC calendar month starts", () => {
    const range = normalizeUsageTrendRange({
      from: "2026-01-18",
      to: "2026-03-02",
      granularity: "month",
    });

    expect(buildUsageTrendBuckets(range).map((bucket) => bucket.periodStart)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
    ]);
  });

  it("rejects invalid dates, reversed ranges, and too many buckets", () => {
    expect(() => normalizeUsageTrendRange({ from: "2026-02-31", to: "2026-03-01", granularity: "day" })).toThrow(
      /Invalid usage trends date range/,
    );
    expect(() => normalizeUsageTrendRange({ from: "2026-03-02", to: "2026-03-01", granularity: "day" })).toThrow(
      /Invalid usage trends date range/,
    );
    expect(() => normalizeUsageTrendRange({ from: "2025-01-01", to: "2026-12-31", granularity: "day" })).toThrow(
      /exceeds the maximum/,
    );
  });
});
