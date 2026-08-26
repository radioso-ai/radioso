import { describe, expect, it } from "vitest";

import { WorkspaceReleaseDeadlineScheduler, type MonotonicClock } from "../../../src/modules/realtime/application/workspaceReleaseDeadlineScheduler.js";

const clockFixture = () => {
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map<number, { callback: () => void; dueAtMs: number }>();
  const clock: MonotonicClock = {
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const id = ++nextTimerId;
      timers.set(id, { callback, dueAtMs: now + delayMs });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => { timers.delete(timer as unknown as number); },
  };
  return {
    clock,
    timers,
    advanceTo: (nextNow: number) => {
      now = nextNow;
      const due = [...timers.entries()].filter(([, timer]) => timer.dueAtMs <= now);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
};

describe("WorkspaceReleaseDeadlineScheduler", () => {
  it("uses one monotonic timer and releases only the current deadline in due order", () => {
    const f = clockFixture();
    const released: string[] = [];
    const scheduler = new WorkspaceReleaseDeadlineScheduler<string>(f.clock, (workspaceId) => released.push(workspaceId));

    scheduler.schedule("late", "late", 30);
    scheduler.schedule("early", "early", 10);
    expect(f.timers.size).toBe(1);

    f.advanceTo(10);
    expect(released).toEqual(["early"]);
    expect(f.timers.size).toBe(1);
    f.advanceTo(30);
    expect(released).toEqual(["early", "late"]);
    expect(f.timers.size).toBe(0);
  });

  it("cancels a stale workspace deadline without allocating a workspace timer", () => {
    const f = clockFixture();
    const released: string[] = [];
    const scheduler = new WorkspaceReleaseDeadlineScheduler<string>(f.clock, (workspaceId) => released.push(workspaceId));

    scheduler.schedule("workspace", "workspace", 10);
    scheduler.cancel("workspace");
    expect(f.timers.size).toBe(0);
    f.advanceTo(10);
    expect(released).toEqual([]);
  });

  it("replaces a workspace deadline in place during reconnect churn", () => {
    const f = clockFixture();
    const released: string[] = [];
    const scheduler = new WorkspaceReleaseDeadlineScheduler<string>(f.clock, (workspaceId) => released.push(workspaceId));

    for (let dueAtMs = 10; dueAtMs <= 1_000; dueAtMs += 10) scheduler.schedule("workspace", "workspace", dueAtMs);
    expect(scheduler.size()).toBe(1);
    f.advanceTo(10);
    expect(released).toEqual([]);
    f.advanceTo(1_000);
    expect(released).toEqual(["workspace"]);
    expect(scheduler.size()).toBe(0);
  });
});
