import { describe, expect, it, vi } from "vitest";

import { ActionDispatchWorker } from "../../src/modules/chat/services/actions/actionDispatchWorker.js";

const silentLogger = { error: vi.fn(), debug: vi.fn() };

describe("ActionDispatchWorker", () => {
  it("drains by delegating to the dispatcher and returns the batch result", async () => {
    const dispatchPending = vi.fn(async () => ({ dispatched: 2, retried: 0, failed: 1 }));
    const worker = new ActionDispatchWorker({ dispatchPending }, { logger: silentLogger, batchSize: 7 });

    const result = await worker.drain();

    expect(dispatchPending).toHaveBeenCalledWith(7);
    expect(result).toEqual({ dispatched: 2, retried: 0, failed: 1 });
  });

  it("skips an overlapping drain while one is already in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatchPending = vi.fn(async () => {
      await gate;
      return { dispatched: 1, retried: 0, failed: 0 };
    });
    const worker = new ActionDispatchWorker({ dispatchPending }, { logger: silentLogger });

    const first = worker.drain();
    const second = await worker.drain(); // first is still awaiting the gate

    expect(second).toBeNull();
    expect(dispatchPending).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toEqual({ dispatched: 1, retried: 0, failed: 0 });
  });

  it("swallows a drain error (logs it) so the poll loop survives", async () => {
    const dispatchPending = vi.fn(async () => {
      throw new Error("db unreachable");
    });
    const logger = { error: vi.fn(), debug: vi.fn() };
    const worker = new ActionDispatchWorker({ dispatchPending }, { logger });

    const result = await worker.drain();

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });

  it("reports a drain error to the error reporter when one is configured", async () => {
    const error = new Error("db unreachable");
    const dispatchPending = vi.fn(async () => {
      throw error;
    });
    const report = vi.fn().mockResolvedValue(undefined);
    const worker = new ActionDispatchWorker(
      { dispatchPending },
      { logger: silentLogger, errorReporter: { report } },
    );

    await worker.drain();

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "action.dispatch.drain_failed",
        error,
        severity: "error",
      }),
    );
  });

  it("swallows a rejecting error reporter so it cannot become an unhandled rejection", async () => {
    const dispatchPending = vi.fn(async () => {
      throw new Error("db unreachable");
    });
    const report = vi.fn().mockRejectedValue(new Error("sink down"));
    const logger = { error: vi.fn(), debug: vi.fn() };
    const worker = new ActionDispatchWorker(
      { dispatchPending },
      { logger, errorReporter: { report } },
    );

    const result = await worker.drain();
    // Let the fire-and-forget report rejection settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: "sink down" }),
      "Action dispatch error report failed",
    );
  });
});
