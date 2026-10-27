import { describe, expect, it, vi } from "vitest";

import { ErrorReportingService } from "../../src/shared/errors/errorReportingService.js";
import type { ErrorSink } from "../../src/shared/errors/errorSink.js";

const createLogger = () => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
});

describe("ErrorReportingService", () => {
  it("normalizes unhandled request errors and records them", async () => {
    const sink: ErrorSink = {
      name: "test-sink",
      record: vi.fn().mockResolvedValue(undefined),
    };
    const logger = createLogger();
    const service = new ErrorReportingService({
      enabled: true,
      environment: "test",
      logger: logger as any,
      service: "radioso-api",
      sinks: [sink],
      version: "test",
    });

    const error = await service.reportUnhandledRequestError({
      error: new Error("boom"),
      request: {
        id: "req-1",
        method: "GET",
        header(name) {
          return name === "x-workspace-id" ? "workspace-1" : undefined;
        },
      },
      statusCode: 500,
    });

    expect(error).toMatchObject({
      errorType: "http.request.unhandled",
      message: "boom",
      errorClass: "Error",
      correlation: {
        requestId: "req-1",
        workspaceId: "workspace-1",
      },
      requestContext: {
        method: "GET",
        statusCode: 500,
      },
    });
    // No route matched this bare request, so none is named (see error-recorded-log-line.test.ts).
    expect(error?.requestContext).not.toHaveProperty("route");
    expect(logger.error).toHaveBeenCalledOnce();
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({
      errorType: "http.request.unhandled",
    }));
  });

  it("redacts sensitive metadata and logs sink failures", async () => {
    const logger = createLogger();
    const service = new ErrorReportingService({
      enabled: true,
      environment: "test",
      logger: logger as any,
      service: "radioso-api",
      sinks: [
        {
          name: "test-sink",
          record: vi.fn().mockRejectedValue(new Error("sink down")),
        },
      ],
    });

    const error = await service.report({
      errorType: "test.error",
      error: {
        prompt: "private",
      },
    });

    expect(error?.metadata).toEqual({
      prompt: "[REDACTED]",
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sinkName: "test-sink", err: expect.objectContaining({ message: "sink down" }), errorType: "test.error" }),
      "error_sink_failed",
    );
  });

  it("preserves caller-provided sanitized error class and stack", async () => {
    const sink: ErrorSink = {
      name: "test-sink",
      record: vi.fn().mockResolvedValue(undefined),
    };
    const service = new ErrorReportingService({
      enabled: true,
      environment: "test",
      logger: createLogger() as any,
      service: "radioso-api",
      sinks: [sink],
    });

    const error = await service.report({
      errorType: "frontend.react.unhandled",
      errorClass: "TypeError",
      message: "Client render failed",
      stack: "TypeError: Client render failed\n    at Dashboard (/w/[workspaceKey]/chat:1:2)",
    });

    expect(error).toMatchObject({
      errorClass: "TypeError",
      message: "Client render failed",
      stack: "TypeError: Client render failed\n    at Dashboard (/w/[workspaceKey]/chat:1:2)",
    });
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({
      errorClass: "TypeError",
      stack: expect.stringContaining("/w/[workspaceKey]/chat"),
    }));
  });

  it("logs lower-severity error events at their modeled severity", async () => {
    const logger = createLogger();
    const service = new ErrorReportingService({
      enabled: true,
      environment: "test",
      logger: logger as any,
      service: "radioso-api",
    });

    await service.report({ errorType: "test.info", message: "notable", severity: "info" });
    await service.report({ errorType: "test.warn", message: "warning", severity: "warn" });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ errorEvent: expect.objectContaining({ severity: "info" }) }),
      "error_recorded",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorEvent: expect.objectContaining({ severity: "warn" }) }),
      "error_recorded",
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("ErrorReportingService.wasReported", () => {
  const buildService = (enabled = true) =>
    new ErrorReportingService({
      enabled,
      environment: "test",
      logger: createLogger() as any,
      service: "radioso-api",
    });

  it("is false before an error has been reported", () => {
    const service = buildService();
    expect(service.wasReported(new Error("boom"))).toBe(false);
  });

  it("is true for the exact error object after report() runs", async () => {
    const service = buildService();
    const error = new Error("boom");
    await service.report({ errorType: "test.error", error });
    expect(service.wasReported(error)).toBe(true);
  });

  it("does not mark a different error object with the same message", async () => {
    const service = buildService();
    await service.report({ errorType: "test.error", error: new Error("boom") });
    expect(service.wasReported(new Error("boom"))).toBe(false);
  });

  it("stays false when reporting is disabled, since report() is a no-op", async () => {
    const service = buildService(false);
    const error = new Error("boom");
    await service.report({ errorType: "test.error", error });
    expect(service.wasReported(error)).toBe(false);
  });

  it("returns false for non-object error values without throwing", () => {
    const service = buildService();
    expect(service.wasReported("boom")).toBe(false);
    expect(service.wasReported(null)).toBe(false);
    expect(service.wasReported(undefined)).toBe(false);
  });
});
