import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionMaintenanceScheduler } from "../../../src/modules/realtime/infrastructure/admissionMaintenanceScheduler.js";

afterEach(() => vi.useRealTimers());

describe("AdmissionMaintenanceScheduler", () => {
  it("services due renewals despite persistent bounded sweep debt", async () => {
    vi.useFakeTimers();
    let now = 0;
    const renewed: string[] = [];
    const scheduler = new AdmissionMaintenanceScheduler({
      now: () => now,
      isCurrent: () => true,
      sweep: async () => ({ hasMore: true }),
      renew: async (work) => { renewed.push(...work.map((item) => item.aggregateId)); },
    });
    scheduler.trackAccount("account", 10);
    scheduler.markDebt("account");
    scheduler.arm({ aggregateId: "due", dueAtMs: 30, version: 1 });
    now = 30;
    await vi.advanceTimersByTimeAsync(30);
    expect(renewed).toEqual(["due"]);
    scheduler.close();
  });

  it("keeps one timer and bounds each due batch", async () => {
    vi.useFakeTimers();
    const batches: number[] = [];
    const scheduler = new AdmissionMaintenanceScheduler({ now: () => Date.now(), isCurrent: () => true, sweep: async () => ({ hasMore: false }), renew: async (work) => { batches.push(work.length); } }, 2);
    scheduler.arm({ aggregateId: "a", dueAtMs: 0, version: 1 });
    scheduler.arm({ aggregateId: "b", dueAtMs: 0, version: 1 });
    scheduler.arm({ aggregateId: "c", dueAtMs: 0, version: 1 });
    expect(scheduler.count()).toBe(1);
    await vi.runAllTimersAsync();
    expect(batches).toEqual([2, 1]);
    scheduler.close();
  });

  it("does not retain debt from an in-flight callback after close", async () => {
    vi.useFakeTimers();
    let resolveSweep!: (result: { hasMore: boolean }) => void;
    const scheduler = new AdmissionMaintenanceScheduler({
      now: () => Date.now(),
      isCurrent: () => true,
      sweep: () => new Promise((resolve) => { resolveSweep = resolve; }),
      renew: async () => undefined,
    });
    scheduler.trackAccount("account", 1);
    scheduler.markDebt("account");
    await vi.advanceTimersByTimeAsync(25);
    scheduler.close();
    resolveSweep({ hasMore: true });
    await Promise.resolve();
    expect(scheduler.debtCount()).toBe(0);
    expect(scheduler.trackedAccountCount()).toBe(0);
  });

  it("compacts stale debt queue storage under account churn", () => {
    const scheduler = new AdmissionMaintenanceScheduler({ now: () => 0, isCurrent: () => true, sweep: async () => ({ hasMore: false }), renew: async () => undefined });
    scheduler.trackAccount("persistent", 1_000);
    scheduler.markDebt("persistent");
    for (let index = 0; index < 500; index += 1) {
      const account = `transient-${index}`;
      scheduler.trackAccount(account, 1_000);
      scheduler.markDebt(account);
      scheduler.clearDebt(account);
      scheduler.releaseAccount(account);
    }
    expect(scheduler.debtCount()).toBe(1);
    expect(scheduler.debtStorageCount()).toBeLessThanOrEqual(35);
    scheduler.close();
  });

  it("keeps due storage proportional to active aggregates under rearm churn", () => {
    const scheduler = new AdmissionMaintenanceScheduler({ now: () => 0, isCurrent: () => true, sweep: async () => ({ hasMore: false }), renew: async () => undefined });
    for (let version = 0; version < 1_000; version += 1) scheduler.arm({ aggregateId: "active", dueAtMs: version + 1, version });
    expect(scheduler.dueStorageCount()).toBeLessThanOrEqual(34);
    scheduler.close();
  });

  it("cancels thousands of distinct due aggregates without retaining timers or map entries", () => {
    const scheduler = new AdmissionMaintenanceScheduler({ now: () => 0, isCurrent: () => true, sweep: async () => ({ hasMore: false }), renew: async () => undefined });
    for (let index = 0; index < 2_000; index += 1) {
      const aggregateId = `aggregate-${index}`;
      scheduler.arm({ aggregateId, dueAtMs: index + 1, version: 1 });
      scheduler.cancel(aggregateId);
    }
    expect(scheduler.dueStorageCount()).toBe(0);
    expect(scheduler.count()).toBe(0);
    scheduler.close();
  });
});
