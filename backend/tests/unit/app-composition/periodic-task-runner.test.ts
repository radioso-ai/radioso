import { afterEach, describe, expect, it, vi } from "vitest";

import { PeriodicTaskRunner } from "../../../src/app/composition/periodicTaskRunner.js";

const createLogger = () => ({ error: vi.fn() });

afterEach(() => {
  vi.useRealTimers();
});

describe("PeriodicTaskRunner", () => {
  it("runs immediately, then on the configured interval, and stops cleanly", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const logger = createLogger();
    const runner = new PeriodicTaskRunner({ id: "test-task", intervalMs: 60_000, run, logger });

    await runner.start();
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);

    await runner.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("never overlaps runs: a tick firing mid-run is skipped", async () => {
    vi.useFakeTimers();
    let resolveFirst!: () => void;
    const run = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveFirst = resolve; }),
    );
    const runner = new PeriodicTaskRunner({ id: "test-task", intervalMs: 10_000, run, logger: createLogger() });

    const starting = runner.start();
    // The initial run is in flight; advancing past two more intervals must not
    // queue additional concurrent calls while it is still pending.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);

    resolveFirst();
    await starting;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("logs and survives a throwing run instead of crashing the process", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const logger = createLogger();
    const runner = new PeriodicTaskRunner({ id: "test-task", intervalMs: 10_000, run, logger });

    await runner.start();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "test-task" }),
      expect.any(String),
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("start() resolves without waiting for the first run to settle, so a hung run never blocks startup", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockImplementation(() => new Promise<void>(() => {})); // never resolves
    const runner = new PeriodicTaskRunner({ id: "test-task", intervalMs: 60_000, run, logger: createLogger() });

    let started = false;
    const starting = runner.start().then(() => { started = true; });
    await vi.advanceTimersByTimeAsync(0);

    expect(started).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    await starting;
  });

  it("stop() returns once its bounded grace period elapses, even though a run never settles", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockImplementation(() => new Promise<void>(() => {})); // never resolves
    const runner = new PeriodicTaskRunner({
      id: "test-task",
      intervalMs: 60_000,
      run,
      logger: createLogger(),
      stopGraceMs: 10_000,
    });

    await runner.start();
    let stopped = false;
    const stopping = runner.stop().then(() => { stopped = true; });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);
  });

  it("stop() waits for an in-flight run to finish before resolving", async () => {
    vi.useFakeTimers();
    let resolveRun!: () => void;
    const run = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveRun = resolve; }),
    );
    const runner = new PeriodicTaskRunner({ id: "test-task", intervalMs: 10_000, run, logger: createLogger() });

    const starting = runner.start();
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopping = runner.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    resolveRun();
    await starting;
    await stopping;
    expect(stopped).toBe(true);
  });

  it("unref()s its timer so it never holds the process open", async () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    const originalSetInterval = global.setInterval;
    // Fake timers return a plain number handle under some environments; force an
    // object with `unref` to assert the runner calls it when available.
    vi.spyOn(global, "setInterval").mockImplementation((...args: Parameters<typeof originalSetInterval>) => {
      const handle = originalSetInterval(...args);
      (handle as unknown as { unref: typeof unref }).unref = unref;
      return handle;
    });
    const runner = new PeriodicTaskRunner({
      id: "test-task",
      intervalMs: 10_000,
      run: vi.fn().mockResolvedValue(undefined),
      logger: createLogger(),
    });

    await runner.start();

    expect(unref).toHaveBeenCalledTimes(1);
    await runner.stop();
  });
});
