import { randomUUID } from "node:crypto";

import type { ReadableLogRecord, LogRecordExporter } from "@opentelemetry/sdk-logs";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpLogger, createLogger } from "../../src/shared/observability/logger.js";
import { createMatchedRouteRecorder } from "../../src/shared/observability/matchedRoute.js";
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
  minimumLevel: "info" | "warn" = "warn",
): void => {
  initializeOpenTelemetryLogging({
    enabled: true,
    environment: "test",
    logger,
    logExporter: exporter,
    minimumLevel,
    otlpEndpoint: "http://localhost:4318/v1/logs",
    runtimeRole: "api",
    serviceName: "radioso-api",
    version: "test-version",
  });
};

const visitorWords = "my daughter has asthma and needs the ground floor room";

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
    logger.warn({ requestId: "req-1", attempt: 1 }, "warning log");

    expect(exporter.records).toHaveLength(1);
    expect(exporter.records[0]?.body).toBe("warning log");
    expect(exporter.records[0]?.severityText).toBe("WARN");
    expect(exporter.records[0]?.attributes).toMatchObject({
      requestId: "req-1",
      attempt: 1,
      "log.logger": "radioso-api",
      "log.pino_level": 40,
    });
  });

  it("drops or redacts sensitive log attributes before export", () => {
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
    const attributes = exporter.records[0]?.attributes;
    expect(attributes).toMatchObject({ apiKey: "[REDACTED]", safeCount: 2 });
    expect(attributes).not.toHaveProperty("connectionString");
    expect(attributes).not.toHaveProperty("prompt");
    expect(JSON.stringify(attributes)).not.toContain("password");
  });

  it("exports only attributes whose value's shape rules out free text, whatever their key", () => {
    const exporter = new RecordingLogExporter();
    initializeLogging(exporter);
    const workspaceId = randomUUID();
    const routineId = randomUUID();

    const logger = createLogger("debug");
    logger.warn({
      err: "Invalid to: jane@example.com",
      errorMessage: `provider said: ${visitorWords}`,
      rerankQuery: visitorWords,
      waId: "15551234567",
      recipient: "jane@example.com",
      labels: ["ok", visitorWords],
      workspaceId,
      routineIds: [routineId],
      outcome: "rate_limited",
      attempt: 2,
      retried: true,
      requestId: "42",
    }, "probe");

    expect(exporter.records).toHaveLength(1);
    const attributes = exporter.records[0]?.attributes ?? {};
    const exported = JSON.stringify(attributes);
    for (const text of ["jane@example.com", visitorWords, "15551234567", "provider said"]) {
      expect(exported).not.toContain(text);
    }
    for (const key of ["errorMessage", "rerankQuery", "waId", "recipient", "labels", "err"]) {
      expect(attributes).not.toHaveProperty(key);
    }
    expect(attributes).toMatchObject({
      errorClass: "string",
      workspaceId,
      routineIds: [routineId],
      outcome: "rate_limited",
      attempt: 2,
      retried: true,
      requestId: "42",
    });
  });

  it("exports class names, SQLSTATE codes, HTTP methods and provider ids under the keys named for them", () => {
    const exporter = new RecordingLogExporter();
    initializeLogging(exporter);

    const logger = createLogger("debug");
    logger.warn({
      errorType: "TypeError",
      errorName: "AbortError",
      errorClass: "AppError [document_not_found]",
      causeType: "SyntaxError",
      code: "57P01",
      sqlState: "23505",
      method: "POST",
      wamid: "wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQUY0QkU1Q0Y2MDE5RTlGNzgA",
      eventId: "evt_1Q2w3E4r5T6y7U8i",
      teamId: "T0123ABCD",
    }, "named keys");
    logger.warn({
      errorType: visitorWords,
      code: "CONTACT JANE",
      method: "post me",
      wamid: "15551234567",
      eventId: "jane@example.com",
      teamId: `T ${visitorWords}`,
    }, "named keys holding something else");

    expect(exporter.records[0]?.attributes).toMatchObject({
      errorType: "TypeError",
      errorName: "AbortError",
      errorClass: "AppError [document_not_found]",
      causeType: "SyntaxError",
      code: "57P01",
      sqlState: "23505",
      method: "POST",
      wamid: "wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQUY0QkU1Q0Y2MDE5RTlGNzgA",
      eventId: "evt_1Q2w3E4r5T6y7U8i",
      teamId: "T0123ABCD",
    });
    const dropped = exporter.records[1]?.attributes ?? {};
    for (const key of ["errorType", "code", "method", "wamid", "eventId", "teamId"]) {
      expect(dropped).not.toHaveProperty(key);
    }
  });

  it("exports a route only when it is a pattern a request matched, never a raw path", async () => {
    const exporter = new RecordingLogExporter();
    initializeLogging(exporter, { error: vi.fn(), info: vi.fn() }, "info");
    const logger = createLogger("debug");
    const app = express();
    app.use(createMatchedRouteRecorder());
    app.use(createHttpLogger(logger));
    const router = express.Router();
    router.get("/otel-probe/:probeToken", (_req, res) => {
      res.status(200).end();
    });
    app.use("/api/v1/test", router);

    await request(app).get("/api/v1/test/otel-probe/secret-probe-token").expect(200);
    logger.warn({ route: "/api/v1/auth/invitations/secret-invite-token" }, "raw route");

    const requestRecord = exporter.records.find((record) => record.body === "request completed");
    expect(requestRecord?.attributes).toMatchObject({ route: "/api/v1/test/otel-probe/:probeToken" });
    const rawRecord = exporter.records.find((record) => record.body === "raw route");
    expect(rawRecord?.attributes).not.toHaveProperty("route");
    expect(JSON.stringify(exporter.records.map((record) => record.attributes))).not.toContain("secret-");
  });

  it("exports error_recorded's allow-listed fields through the same shape checks", () => {
    const exporter = new RecordingLogExporter();
    initializeLogging(exporter);
    const workspaceId = randomUUID();

    const logger = createLogger("debug");
    logger.error({
      errorEvent: {
        errorType: "chat.turn.failed",
        severity: "error",
        errorClass: "TypeError",
        method: "GET",
        requestId: "17",
        workspaceId,
        route: "/api/v1/auth/invitations/secret-invite-token",
        detail: visitorWords,
      },
    }, "error_recorded");

    const attributes = exporter.records[0]?.attributes ?? {};
    expect(attributes).toMatchObject({
      "errorEvent.errorType": "chat.turn.failed",
      "errorEvent.severity": "error",
      "errorEvent.errorClass": "TypeError",
      "errorEvent.method": "GET",
      "errorEvent.requestId": "17",
      "errorEvent.workspaceId": workspaceId,
    });
    expect(attributes).not.toHaveProperty("errorEvent.route");
    expect(JSON.stringify(attributes)).not.toContain("secret-invite-token");
    expect(JSON.stringify(attributes)).not.toContain(visitorWords);
  });

  it("exports an error's status and its cause's class and code, never a message", () => {
    const exporter = new RecordingLogExporter();
    initializeLogging(exporter);

    const socketError = Object.assign(new Error(`connect ECONNREFUSED for ${visitorWords}`), { code: "ECONNREFUSED" });
    const logger = createLogger("debug");
    logger.error({ err: Object.assign(new TypeError("fetch failed", { cause: socketError }), { status: 503 }) }, "provider call failed");

    const attributes = exporter.records[0]?.attributes;
    expect(attributes).toMatchObject({
      errorClass: "TypeError",
      errorStatus: 503,
      errorCauseClass: "Error",
      errorCauseCode: "ECONNREFUSED",
    });
    expect(JSON.stringify(attributes)).not.toContain(visitorWords);
    expect(JSON.stringify(attributes)).not.toContain("fetch failed");
  });

  it("names a nested Error's class from structured Pino records but never its message", () => {
    const exporter = new RecordingLogExporter();
    initializeLogging(exporter);

    const logger = createLogger("debug");
    logger.error({ err: new Error(`provider said: ${visitorWords}`), workspaceId: "workspace-1" }, "worker failed");
    logger.error({ error: new TypeError(`rejected "${visitorWords}"`), jobId: "job-1" }, "job failed");

    expect(exporter.records).toHaveLength(2);
    expect(exporter.records[0]?.attributes).toMatchObject({
      errorClass: "Error",
      workspaceId: "workspace-1",
    });
    expect(exporter.records[1]?.attributes).toMatchObject({
      errorClass: "TypeError",
      jobId: "job-1",
    });
    expect(JSON.stringify(exporter.records[0]?.attributes)).not.toContain(visitorWords);
    expect(JSON.stringify(exporter.records[1]?.attributes)).not.toContain(visitorWords);
    expect(exporter.records[0]?.attributes).not.toHaveProperty("err");
    expect(exporter.records[1]?.attributes).not.toHaveProperty("errorMessage");
  });

  it("names a top-level thrown Error's class but never its message", () => {
    const exporter = new RecordingLogExporter();
    initializeLogging(exporter);

    const logger = createLogger("debug");
    logger.error(new RangeError(`out of range: ${visitorWords}`));

    expect(exporter.records).toHaveLength(1);
    expect(exporter.records[0]?.attributes).toMatchObject({ errorClass: "RangeError" });
    expect(JSON.stringify(exporter.records[0]?.attributes)).not.toContain(visitorWords);
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

    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: "provider failed" }) },
      "otel_logging_shutdown_failed",
    );
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
