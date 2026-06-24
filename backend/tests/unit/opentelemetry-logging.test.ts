import type { ReadableLogRecord, LogRecordExporter } from "@opentelemetry/sdk-logs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../../src/shared/observability/logger.js";
import {
  initializeOpenTelemetryLogging,
  shutdownOpenTelemetryLogging,
} from "../../src/shared/observability/logging/index.js";

class RecordingLogExporter implements LogRecordExporter {
  readonly records: ReadableLogRecord[] = [];
  readonly forceFlush = vi.fn().mockResolvedValue(undefined);
  readonly shutdown = vi.fn().mockResolvedValue(undefined);

  export(records: ReadableLogRecord[], callback: Parameters<LogRecordExporter["export"]>[1]): void {
    this.records.push(...records);
    callback({ code: 0 });
  }
}

const initializeLogging = (
  exporter: LogRecordExporter,
  logger = {
    error: vi.fn(),
    info: vi.fn(),
  },
): void => {
  initializeOpenTelemetryLogging({
    enabled: true,
    environment: "test",
    logger,
    logExporter: exporter,
    minimumLevel: "warn",
    otlpEndpoint: "http://localhost:4318/v1/logs",
    runtimeRole: "api",
    serviceName: "radioso-api",
    version: "test-version",
  });
};

describe("OpenTelemetry log bridge", () => {
  afterEach(async () => {
    await shutdownOpenTelemetryLogging();
    vi.useRealTimers();
  });

  it("exports Pino records at or above the configured level", () => {
    const exporter = new RecordingLogExporter();
    initializeLogging(exporter);

    const logger = createLogger("debug");
    logger.info({ requestId: "req-ignored" }, "ignored info log");
    logger.warn({ requestId: "req-1", route: "/api/v1/test" }, "warning log");

    expect(exporter.records).toHaveLength(1);
    expect(exporter.records[0]?.body).toBe("warning log");
    expect(exporter.records[0]?.severityText).toBe("WARN");
    expect(exporter.records[0]?.attributes).toMatchObject({
      requestId: "req-1",
      route: "/api/v1/test",
      "log.logger": "radioso-api",
      "log.pino_level": 40,
    });
  });

  it("redacts sensitive log attributes before export", () => {
    const exporter = new RecordingLogExporter();
    initializeLogging(exporter);

    const logger = createLogger("debug");
    logger.error({
      apiKey: "secret",
      connectionString: "postgres://user:password@example.com/db",
      prompt: "private prompt",
      safeCount: 2,
    }, "redacted error log");

    expect(exporter.records).toHaveLength(1);
    expect(exporter.records[0]?.attributes).toMatchObject({
      apiKey: "[REDACTED]",
      connectionString: "[REDACTED]",
      prompt: "[REDACTED]",
      safeCount: 2,
    });
  });

  it("preserves nested Error details from structured Pino records", () => {
    const exporter = new RecordingLogExporter();
    initializeLogging(exporter);

    const logger = createLogger("debug");
    logger.error({ err: new Error("database unavailable"), workspaceId: "workspace-1" }, "worker failed");
    logger.error({ error: new TypeError("invalid payload"), jobId: "job-1" }, "job failed");

    expect(exporter.records).toHaveLength(2);
    expect(exporter.records[0]?.attributes).toMatchObject({
      err: "database unavailable",
      errorClass: "Error",
      workspaceId: "workspace-1",
    });
    expect(exporter.records[1]?.attributes).toMatchObject({
      errorMessage: "invalid payload",
      errorClass: "TypeError",
      jobId: "job-1",
    });
  });

  it("does not leave the shutdown timeout timer pending after a successful shutdown", async () => {
    vi.useFakeTimers();
    const exporter = new RecordingLogExporter();
    initializeLogging(exporter);

    await shutdownOpenTelemetryLogging();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs shutdown failures without rejecting runtime shutdown", async () => {
    const logger = {
      error: vi.fn(),
      info: vi.fn(),
    };
    const exporter: LogRecordExporter = {
      export(_records, callback) {
        callback({ code: 0 });
      },
      forceFlush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockRejectedValue(new Error("provider failed")),
    };
    initializeLogging(exporter, logger);

    await expect(shutdownOpenTelemetryLogging()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith({ err: "provider failed" }, "otel_logging_shutdown_failed");
  });

  it("keeps disabled OpenTelemetry logging as a no-op", () => {
    initializeOpenTelemetryLogging({
      enabled: false,
      environment: "test",
      runtimeRole: "api",
      serviceName: "radioso-api",
    });

    expect(() => createLogger("debug").warn("disabled log")).not.toThrow();
  });
});
