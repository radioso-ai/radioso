import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/shared/domain/errors.js";
import { errorReportMessage, errorSummaryOf } from "../../src/shared/errors/errorReportShape.js";
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
      message: "http.request.unhandled: Error",
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
      error: new Error("private"),
      metadata: {
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

  it("keeps a caller-provided error class and the frames of its stack", async () => {
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
      stack: "TypeError: Client render failed\n    at Dashboard (/w/[workspaceKey]/chat:1:2)\nrender@/_next/static/chunks/app.js:3:4",
    });

    expect(error).toMatchObject({
      errorClass: "TypeError",
      message: "frontend.react.unhandled: TypeError",
      stack: "    at Dashboard (/w/[workspaceKey]/chat:1:2)\nrender@/_next/static/chunks/app.js:3:4",
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

    await service.report({ errorType: "test.info", message: errorReportMessage`notable`, severity: "info" });
    await service.report({ errorType: "test.warn", message: errorReportMessage`warning`, severity: "warn" });

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

describe("what an error sink receives", () => {
  const visitorWords = "my daughter has asthma and needs the ground floor room";

  const recordingService = () => {
    const record = vi.fn<ErrorSink["record"]>().mockResolvedValue(undefined);
    const service = new ErrorReportingService({
      enabled: true,
      environment: "test",
      logger: createLogger() as any,
      service: "radioso-worker",
      sinks: [{ name: "test-sink", record }],
    });
    return { service, received: () => record.mock.calls[0]?.[0] };
  };

  it("never sees an error's own message, in the message or the stack", async () => {
    const { service, received } = recordingService();

    await service.report({
      errorType: "document.worker.tick_failed",
      error: new TypeError(`Could not parse "${visitorWords}"\n    and again on a second line: ${visitorWords}`),
    });

    expect(JSON.stringify(received())).not.toContain(visitorWords);
    expect(received()).toMatchObject({
      errorClass: "TypeError",
      message: "document.worker.tick_failed: TypeError",
    });
    const frames = received()?.stack?.split("\n") ?? [];
    expect(frames[0]).toContain("error-reporting-service.test.ts");
    expect(frames.every((frame) => frame.trimStart().startsWith("at "))).toBe(true);
  });

  it("names an application error by its class and code", async () => {
    const { service, received } = recordingService();

    await service.report({
      errorType: "document.worker.post_job_maintenance_failed",
      error: new AppError(503, "service_unavailable", `Upstream said: ${visitorWords}`),
    });

    expect(JSON.stringify(received())).not.toContain(visitorWords);
    expect(received()).toMatchObject({
      errorClass: "AppError",
      code: "service_unavailable",
      message: "document.worker.post_job_maintenance_failed: AppError [service_unavailable]",
    });
  });

  it("names what an error wraps by class and code, never by message", async () => {
    const { service, received } = recordingService();
    const cause = Object.assign(new Error(`current transaction is aborted near "${visitorWords}"`), { name: "DatabaseError", code: "25P02" });

    await service.report({
      errorType: "vector.index.reconciliation_tick_failed",
      error: Object.assign(new AppError(503, "service_unavailable", "Abuse control enforcement is unavailable"), { cause }),
    });

    expect(JSON.stringify(received())).not.toContain(visitorWords);
    expect(JSON.stringify(received())).not.toContain("current transaction is aborted");
    expect(received()).toMatchObject({
      causes: [{ errorClass: "DatabaseError", code: "25P02" }],
      message: "vector.index.reconciliation_tick_failed: AppError [service_unavailable] caused by DatabaseError [25P02]",
    });
  });

  it("keeps nothing of a thrown value that is not an error", async () => {
    const { service, received } = recordingService();

    await service.report({ errorType: "process.unhandledRejection", error: { prompt: visitorWords, detail: visitorWords } });

    expect(JSON.stringify(received())).not.toContain(visitorWords);
    expect(received()).toMatchObject({ errorClass: "NonErrorThrowable", message: "process.unhandledRejection: NonErrorThrowable" });
  });

  it("drops a caller-provided error class that is not shaped like one", async () => {
    const { service, received } = recordingService();

    await service.report({ errorType: "frontend.runtime.unhandled", errorClass: `visitor typed ${visitorWords}` });

    expect(JSON.stringify(received())).not.toContain(visitorWords);
    expect(received()).toMatchObject({ message: "frontend.runtime.unhandled", fingerprint: "radioso-worker:frontend.runtime.unhandled:UnknownError" });
    expect(received()).not.toHaveProperty("errorClass");
  });

  it("reduces an error a caller puts in metadata to its class, code and frames", async () => {
    const { service, received } = recordingService();

    await service.report({
      errorType: "hitl.ownership.notification_failed",
      metadata: { attempt: 2, cause: Object.assign(new Error(`push to ${visitorWords} failed`), { code: "ECONNRESET" }) },
    });

    expect(JSON.stringify(received())).not.toContain(visitorWords);
    expect(received()?.metadata).toMatchObject({ attempt: 2, cause: { name: "Error", code: "ECONNRESET" } });
    const frames = (received()?.metadata?.cause as { stack?: string } | undefined)?.stack?.split("\n") ?? [];
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.trimStart().startsWith("at "))).toBe(true);
  });

  it("carries a caller's message built from safe values, and redacts a value that is not one", async () => {
    const { service, received } = recordingService();
    const summary = "AppError [provider_unavailable]";

    await service.report({
      errorType: "background_job.dead_lettered.facets.extraction",
      errorClass: "AppError",
      message: errorReportMessage`facets.extraction dead-lettered: ${summary} after ${3} attempts, last said ${visitorWords}`,
    });

    expect(received()?.message).toBe("facets.extraction dead-lettered: AppError [provider_unavailable] after 3 attempts, last said [REDACTED]");
  });

  it("keeps a summary errorSummaryOf wrote, codes and cause chain included, in a caller's message", () => {
    const summary = errorSummaryOf(
      Object.assign(new AppError(503, "service_unavailable", visitorWords), {
        cause: Object.assign(new Error(visitorWords), { name: "DatabaseError", code: "25P02", cause: Object.assign(new Error(visitorWords), { code: "ECONNRESET" }) }),
      }),
    );

    expect(summary).toBe("AppError [service_unavailable] caused by DatabaseError [25P02] caused by Error [ECONNRESET]");
    expect(errorReportMessage`tick failed: ${summary}`).toBe(`tick failed: ${summary}`);
    expect(errorReportMessage`retry: ${errorSummaryOf(Object.assign(new Error("x"), { code: -104 }))}`).toBe("retry: Error [-104]");
    expect(errorReportMessage`then: ${`${summary} caused by ${visitorWords}`}`).toBe("then: [REDACTED]");
  });

  it("keeps a number in a caller's message only when it is small enough to be a code or a count", () => {
    expect(errorReportMessage`attempt ${3} of ${5}`).toBe("attempt 3 of 5");
    expect(errorReportMessage`call ${4915112345678}`).toBe("call [REDACTED]");
    expect(errorReportMessage`ratio ${Number.NaN}`).toBe("ratio [REDACTED]");
  });

  it("fingerprints a report on its service, type, class and code, so distinct failures stay distinct", async () => {
    const { service } = recordingService();

    const plain = await service.report({ errorType: "document.worker.tick_failed", error: new TypeError("a") });
    const coded = await service.report({ errorType: "document.worker.tick_failed", error: new AppError(500, "internal_error", "b") });
    const otherCode = await service.report({ errorType: "document.worker.tick_failed", error: new AppError(503, "service_unavailable", "c") });
    const sameAsCoded = await service.report({ errorType: "document.worker.tick_failed", error: new AppError(500, "internal_error", "d") });

    expect(plain?.fingerprint).toBe("radioso-worker:document.worker.tick_failed:TypeError");
    expect(coded?.fingerprint).toBe("radioso-worker:document.worker.tick_failed:AppError:internal_error");
    expect(otherCode?.fingerprint).toBe("radioso-worker:document.worker.tick_failed:AppError:service_unavailable");
    expect(sameAsCoded?.fingerprint).toBe(coded?.fingerprint);
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
