import { describe, expect, it } from "vitest";

import {
  RECRAWL_JITTER_MAX_MS,
  effectiveRecrawlCadence,
  firstRecrawlAt,
  isRecrawlCadenceWithinPlan,
  nextRecrawlAfterRun,
  recrawlJitterMs,
} from "../../../src/modules/websiteCrawler/recrawlSchedule.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const now = new Date("2026-11-21T12:00:00.000Z");

describe("recrawl cadence against the plan's fastest cadence", () => {
  it("admits off and monthly on every plan, and a faster cadence only where the plan allows it", () => {
    expect(isRecrawlCadenceWithinPlan("off", "monthly")).toBe(true);
    expect(isRecrawlCadenceWithinPlan("monthly", "monthly")).toBe(true);
    expect(isRecrawlCadenceWithinPlan("weekly", "monthly")).toBe(false);
    expect(isRecrawlCadenceWithinPlan("daily", "monthly")).toBe(false);
    expect(isRecrawlCadenceWithinPlan("monthly", "daily")).toBe(true);
    expect(isRecrawlCadenceWithinPlan("off", "weekly")).toBe(true);
    expect(isRecrawlCadenceWithinPlan("weekly", "weekly")).toBe(true);
    expect(isRecrawlCadenceWithinPlan("weekly", "daily")).toBe(true);
    expect(isRecrawlCadenceWithinPlan("daily", "daily")).toBe(true);
    expect(isRecrawlCadenceWithinPlan("daily", "weekly")).toBe(false);
  });

  it("runs a stored choice faster than the plan allows at the plan's fastest cadence", () => {
    expect(effectiveRecrawlCadence("daily", "weekly")).toBe("weekly");
    expect(effectiveRecrawlCadence("daily", "daily")).toBe("daily");
    expect(effectiveRecrawlCadence("weekly", "daily")).toBe("weekly");
    expect(effectiveRecrawlCadence("off", "daily")).toBe("off");
    expect(effectiveRecrawlCadence("daily", "monthly")).toBe("monthly");
    expect(effectiveRecrawlCadence("weekly", "monthly")).toBe("monthly");
    expect(effectiveRecrawlCadence("monthly", "daily")).toBe("monthly");
  });
});

describe("when a source next recrawls", () => {
  it("has no next recrawl while the cadence is off", () => {
    expect(firstRecrawlAt({ now, lastSyncedAt: null, cadence: "off", jitterMs: 0 })).toBeNull();
  });

  it("starts from now, plus jitter, for a source never synced or synced longer ago than the interval", () => {
    expect(firstRecrawlAt({ now, lastSyncedAt: null, cadence: "daily", jitterMs: 5_000 }))
      .toEqual(new Date(now.getTime() + 5_000));
    expect(firstRecrawlAt({ now, lastSyncedAt: new Date(now.getTime() - 3 * DAY_MS), cadence: "daily", jitterMs: 0 }))
      .toEqual(now);
  });

  it("waits one interval after the last sync when that is later than now", () => {
    const lastSyncedAt = new Date(now.getTime() - 2 * HOUR_MS);
    expect(firstRecrawlAt({ now, lastSyncedAt, cadence: "daily", jitterMs: 0 }))
      .toEqual(new Date(lastSyncedAt.getTime() + DAY_MS));
    expect(firstRecrawlAt({ now, lastSyncedAt, cadence: "weekly", jitterMs: 60_000 }))
      .toEqual(new Date(lastSyncedAt.getTime() + 7 * DAY_MS + 60_000));
  });

  it("advances a run by one interval of the cadence it ran at, plus jitter", () => {
    expect(nextRecrawlAfterRun({ now, cadence: "daily", jitterMs: 0 })).toEqual(new Date(now.getTime() + DAY_MS));
    expect(nextRecrawlAfterRun({ now, cadence: "weekly", jitterMs: 30_000 }))
      .toEqual(new Date(now.getTime() + 7 * DAY_MS + 30_000));
  });

  it("recrawls monthly every 30 days", () => {
    expect(nextRecrawlAfterRun({ now, cadence: "monthly", jitterMs: 10_000 }))
      .toEqual(new Date(now.getTime() + 30 * DAY_MS + 10_000));
    expect(firstRecrawlAt({ now, lastSyncedAt: now, cadence: "monthly", jitterMs: 0 }))
      .toEqual(new Date(now.getTime() + 30 * DAY_MS));
  });

  it("draws jitter between zero and an hour", () => {
    expect(RECRAWL_JITTER_MAX_MS).toBe(HOUR_MS);
    expect(recrawlJitterMs(() => 0)).toBe(0);
    expect(recrawlJitterMs(() => 0.5)).toBe(HOUR_MS / 2);
    expect(recrawlJitterMs(() => 0.999_999)).toBeLessThan(HOUR_MS);
  });
});
