import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { installProcessErrorHandlers } from "../../src/runtime/processErrorHandlers.js";

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const createLogger = () => ({ error: vi.fn() });

describe("installProcessErrorHandlers", () => {
  it("reports an uncaught exception and exits with code 1", async () => {
    const target = new EventEmitter();
    const report = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const logger = createLogger();

    installProcessErrorHandlers({
      reporter: { report },
      logger: logger as never,
      role: "api",
      exit,
      target,
    });

    const error = new Error("boom");
    target.emit("uncaughtException", error);
    await flushMicrotasks();

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "process.uncaughtException",
        error,
        severity: "error",
      }),
    );
    expect(logger.error).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("reports an unhandled rejection (using the rejection reason) and exits", async () => {
    const target = new EventEmitter();
    const report = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();

    installProcessErrorHandlers({
      reporter: { report },
      logger: createLogger() as never,
      role: "worker",
      exit,
      target,
    });

    const reason = new Error("rejected");
    target.emit("unhandledRejection", reason, Promise.reject(reason).catch(() => undefined));
    await flushMicrotasks();

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: "process.unhandledRejection", error: reason }),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("still exits when the reporter itself fails", async () => {
    const target = new EventEmitter();
    const report = vi.fn().mockRejectedValue(new Error("sink down"));
    const exit = vi.fn();
    const logger = createLogger();

    installProcessErrorHandlers({
      reporter: { report },
      logger: logger as never,
      role: "api",
      exit,
      target,
    });

    target.emit("uncaughtException", new Error("boom"));
    await flushMicrotasks();

    expect(exit).toHaveBeenCalledWith(1);
    // both the fatal error and the reporter failure are logged
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("exits even if the reporter never settles, bounded by the flush timeout", async () => {
    vi.useFakeTimers();
    try {
      const target = new EventEmitter();
      const report = vi.fn().mockReturnValue(new Promise<void>(() => {}));
      const exit = vi.fn();

      installProcessErrorHandlers({
        reporter: { report },
        logger: createLogger() as never,
        role: "api",
        exit,
        target,
        flushTimeoutMs: 2_000,
      });

      target.emit("uncaughtException", new Error("boom"));
      await vi.advanceTimersByTimeAsync(2_000);

      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports each fatal event only once even if more arrive during flush", async () => {
    const target = new EventEmitter();
    let resolveReport!: () => void;
    const report = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
      resolveReport = resolve;
    }));
    const exit = vi.fn();

    installProcessErrorHandlers({
      reporter: { report },
      logger: createLogger() as never,
      role: "api",
      exit,
      target,
    });

    target.emit("uncaughtException", new Error("first"));
    target.emit("uncaughtException", new Error("second"));
    resolveReport();
    await flushMicrotasks();

    expect(report).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("removes its listeners when the returned dispose is called", () => {
    const target = new EventEmitter();
    const dispose = installProcessErrorHandlers({
      reporter: { report: vi.fn() },
      logger: createLogger() as never,
      role: "api",
      exit: vi.fn(),
      target,
    });

    expect(target.listenerCount("uncaughtException")).toBe(1);
    expect(target.listenerCount("unhandledRejection")).toBe(1);

    dispose();

    expect(target.listenerCount("uncaughtException")).toBe(0);
    expect(target.listenerCount("unhandledRejection")).toBe(0);
  });
});
