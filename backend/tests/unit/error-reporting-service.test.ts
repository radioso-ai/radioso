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
        originalUrl: "/api/v1/settings/retrieval",
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
        route: "/api/v1/settings/retrieval",
        statusCode: 500,
      },
    });
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
      expect.objectContaining({ err: "sink down", errorType: "test.error" }),
      "error_sink_failed",
    );
  });

  it("preserves caller-provided sanitized error class and stack", async () => {
    const sink: ErrorSink = {
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
      expect.objectContaining({ error: expect.objectContaining({ severity: "info" }) }),
      "error_recorded",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ severity: "warn" }) }),
      "error_recorded",
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
