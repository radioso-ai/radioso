import express from "express";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpTracingMiddleware } from "../../src/app/http/middleware/tracingMiddleware.js";
import { initializeTracing, shutdownTracing } from "../../src/shared/observability/tracing/index.js";

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

describe("OpenTelemetry HTTP tracing middleware", () => {
  afterEach(async () => {
    await shutdownTracing();
  });

  it("exports a root span with safe request and response attributes", async () => {
    const exporter = new RecordingExporter();
    initializeTracing({
      enabled: true,
      environment: "test",
      otlpEndpoint: "http://localhost:4318/v1/traces",
      runtimeRole: "api",
      serviceName: "radioso-api",
      spanExporter: exporter,
    });
    const app = express();
    app.use((req, _res, next) => {
      (req as typeof req & { id: string }).id = "request-1";
      next();
    });
    app.use(createHttpTracingMiddleware());
    app.get("/health", (_req, res) => {
      res.status(204).end();
    });

    await request(app).get("/health?token=secret").expect(204);

    expect(exporter.spans).toHaveLength(1);
    expect(exporter.spans[0]?.name).toBe("http.server.request");
    expect(exporter.spans[0]?.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.response.status_code": 204,
      "http.route": "/health",
      "radioso.request_id": "request-1",
    });
    expect(JSON.stringify(exporter.spans[0]?.attributes)).not.toContain("secret");
  });

  it("does not export raw unmatched paths as routes", async () => {
    const exporter = new RecordingExporter();
    initializeTracing({
      enabled: true,
      environment: "test",
      otlpEndpoint: "http://localhost:4318/v1/traces",
      runtimeRole: "api",
      serviceName: "radioso-api",
      spanExporter: exporter,
    });
    const app = express();
    app.use(createHttpTracingMiddleware());

    await request(app).get("/public-chat/token-secret/messages").expect(404);

    expect(exporter.spans).toHaveLength(1);
    expect(exporter.spans[0]?.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.response.status_code": 404,
    });
    expect(exporter.spans[0]?.attributes).not.toHaveProperty("http.route");
    expect(JSON.stringify(exporter.spans[0]?.attributes)).not.toContain("token-secret");
  });
});
