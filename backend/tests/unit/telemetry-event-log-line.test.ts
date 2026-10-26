import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../../src/shared/observability/logger.js";
import { createMatchedRouteRecorder } from "../../src/shared/observability/matchedRoute.js";
import { createRequestTelemetryMiddleware, TelemetryService } from "../../src/shared/observability/telemetry/telemetryService.js";
import type { TelemetryEvent, TelemetrySink } from "../../src/shared/observability/telemetry/telemetrySink.js";

const providerMessage = "Invalid input: the chunk 'my daughter has asthma' exceeds the model's limit";

const captureTelemetry = (): { service: TelemetryService; lines: () => Record<string, unknown>[]; raw: () => string; events: TelemetryEvent[] } => {
  const chunks: string[] = [];
  const events: TelemetryEvent[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const sink: TelemetrySink = {
    emit: vi.fn(async (event: TelemetryEvent) => {
      events.push(event);
    }),
  };
  return {
    service: new TelemetryService({ environment: "test", logger: createLogger("info", stream), service: "radioso-api", sinks: [sink] }),
    lines: () => chunks.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
    raw: () => chunks.join(""),
    events,
  };
};

describe("telemetry_event log line", () => {
  it("keeps metadata whose shape rules out free text and drops an error message carried as a reason", async () => {
    const { service, lines, raw, events } = captureTelemetry();
    const documentId = randomUUID();

    await service.emit({
      eventType: "document.worker.job_failed",
      correlation: { documentId },
      metadata: { reason: providerMessage, fallbackReason: "rerank_timeout", retried: true, attempt: 2 },
      tags: { outcome: "failed" },
    });

    expect(raw()).not.toContain("asthma");
    expect((lines()[0]?.telemetry as { metadata?: unknown }).metadata).toEqual({ fallbackReason: "rerank_timeout", retried: true, attempt: 2 });
    // The sinks still receive the event whole.
    expect(events[0]?.metadata).toMatchObject({ reason: providerMessage });
  });

  it("names a request by its matched route pattern, and an unmatched one by no path at all", async () => {
    const { service, raw, events } = captureTelemetry();
    const app = express();
    app.use(createMatchedRouteRecorder());
    app.use(createRequestTelemetryMiddleware(service));
    const router = express.Router();
    router.get("/:token/messages", (_req, res) => {
      res.status(200).end();
    });
    app.use("/api/v1/public/chat", router);

    await request(app).get("/api/v1/public/chat/super-secret-chat-token/messages").expect(200);
    await request(app).get("/api/v1/auth/invitations/short-token").expect(404);
    await vi.waitFor(() => expect(events).toHaveLength(2));

    expect(raw()).not.toContain("super-secret-chat-token");
    expect(raw()).not.toContain("short-token");
    expect(JSON.stringify(events)).not.toContain("super-secret-chat-token");
    expect(JSON.stringify(events)).not.toContain("short-token");
    expect(events[0]).toMatchObject({ tags: { route: "/api/v1/public/chat/:token/messages" }, correlation: { route: "/api/v1/public/chat/:token/messages" } });
    expect(events[1]?.tags).toMatchObject({ route: "unmatched" });
    expect(events[1]?.correlation).not.toHaveProperty("route");
  });
});
