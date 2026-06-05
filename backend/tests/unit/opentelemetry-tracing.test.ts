import { SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  correlationAttributes,
  currentTraceCorrelation,
  initializeTracing,
  safeTraceAttributes,
  shutdownTracing,
  startActiveSpan,
} from "../../src/shared/observability/tracing/index.js";

class RecordingExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], callback: Parameters<SpanExporter["export"]>[1]): void {
    this.spans.push(...spans);
    callback({ code: 0 });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const enabledConfig = (exporter: SpanExporter) => ({
  enabled: true,
  environment: "test",
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
  otlpEndpoint: "http://localhost:4318/v1/traces",
  runtimeRole: "api",
  serviceName: "radioso-api",
  spanExporter: exporter,
  version: "test-version",
} as const);

describe("OpenTelemetry tracing helpers", () => {
  afterEach(async () => {
    await shutdownTracing();
  });

  it("keeps disabled tracing as a no-op while preserving callback behavior", async () => {
    initializeTracing({
      enabled: false,
      environment: "test",
      runtimeRole: "api",
      serviceName: "radioso-api",
    });

    const value = await startActiveSpan("disabled.operation", { prompt: "private" }, async () => {
      expect(currentTraceCorrelation()).toBeUndefined();
      return "ok";
    });

    expect(value).toBe("ok");
  });

  it("uses async context propagation for nested active spans", async () => {
    const exporter = new RecordingExporter();
    initializeTracing(enabledConfig(exporter));

    await startActiveSpan("radioso.parent", correlationAttributes({
      requestId: "req-1",
      runtimeRole: "api",
      workspaceId: "workspace-1",
    }), async () => {
      const parentCorrelation = currentTraceCorrelation();

      await Promise.resolve();

      await startActiveSpan("radioso.child", { "radioso.document_id": "doc-1" }, async () => {
        const childCorrelation = currentTraceCorrelation();
        expect(childCorrelation?.traceId).toBe(parentCorrelation?.traceId);
        expect(childCorrelation?.spanId).not.toBe(parentCorrelation?.spanId);
        expect(childCorrelation?.sampled).toBe(true);
      });
    });

    expect(exporter.spans.map((span) => span.name)).toEqual([
      "radioso.child",
      "radioso.parent",
    ]);

    const [child, parent] = exporter.spans;
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(parent.attributes).toMatchObject({
      "radioso.request_id": "req-1",
      "radioso.runtime_role": "api",
      "radioso.workspace_id": "workspace-1",
    });
  });

  it("redacts prohibited attributes, strips URL secrets, and bounds arbitrary values", () => {
    const attributes = safeTraceAttributes({
      accessToken: "secret-token",
      connectionString: "postgres://user:password@example.com/db",
      "document.title": "x".repeat(400),
      "http.url": "https://example.com/search?q=test&token=secret#fragment",
      prompt: "private prompt",
      resultCount: 3,
    });

    expect(attributes).toEqual({
      accessToken: "[REDACTED]",
      connectionString: "[REDACTED]",
      "document.title": `${"x".repeat(256)}...`,
      "http.url": "https://example.com/search",
      prompt: "[REDACTED]",
      resultCount: 3,
    });
  });

  it("records span errors without swallowing product errors", async () => {
    const exporter = new RecordingExporter();
    initializeTracing(enabledConfig(exporter));

    await expect(startActiveSpan("radioso.failure", {}, async () => {
      throw new TypeError("boom");
    })).rejects.toThrow("boom");

    expect(exporter.spans).toHaveLength(1);
    expect(exporter.spans[0]?.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "TypeError",
    });
  });

  it("logs shutdown failures without throwing", () => {
    const logger = {
      error: vi.fn(),
      info: vi.fn(),
    };

    initializeTracing({
      enabled: true,
      environment: "test",
      logger,
      otlpEndpoint: "http://localhost:4318/v1/traces",
      runtimeRole: "api",
      serviceName: "radioso-api",
      spanExporter: {
        export(_spans: ReadableSpan[], callback: Parameters<SpanExporter["export"]>[1]): void {
          callback({ code: 1 });
        },
        shutdown: vi.fn().mockRejectedValue(new Error("collector down")),
      },
    });

    return shutdownTracing().then(() => {
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: "collector down" }),
        "otel_shutdown_failed",
      );
    });
  });
});
