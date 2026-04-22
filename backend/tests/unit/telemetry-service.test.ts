import { describe, expect, it, vi } from "vitest";

import { TelemetryService } from "../../src/shared/observability/telemetry/telemetryService.js";
import type { TelemetrySink } from "../../src/shared/observability/telemetry/telemetrySink.js";

const createLogger = () => ({
  info: vi.fn(),
  error: vi.fn(),
});

describe("TelemetryService", () => {
  it("logs and emits redacted telemetry events", async () => {
    const sink: TelemetrySink = {
      emit: vi.fn().mockResolvedValue(undefined),
    };
    const logger = createLogger();
    const service = new TelemetryService({
      enabled: true,
      environment: "test",
      logger: logger as any,
      service: "radioso-api",
      sinks: [sink],
      version: "test",
    });

    const event = await service.emit({
      eventType: "http.request.completed",
      correlation: { requestId: "req-1" },
      metadata: {
        prompt: "private",
        ok: "value",
      },
      metrics: { durationMs: 12 },
      tags: { route: "/health" },
    });

    expect(event).toMatchObject({
      eventType: "http.request.completed",
      service: "radioso-api",
      environment: "test",
      correlation: { requestId: "req-1" },
      metadata: {
        prompt: "[REDACTED]",
        ok: "value",
      },
    });
    expect(logger.info).toHaveBeenCalledOnce();
    expect(sink.emit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "http.request.completed",
    }));
  });

  it("logs sink failures but does not throw", async () => {
    const logger = createLogger();
    const service = new TelemetryService({
      enabled: true,
      environment: "test",
      logger: logger as any,
      service: "radioso-api",
      sinks: [
        {
          emit: vi.fn().mockRejectedValue(new Error("down")),
        },
      ],
    });

    await expect(service.emit({ eventType: "test.event" })).resolves.toBeTruthy();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: "down", eventType: "test.event" }),
      "telemetry_sink_failed",
    );
  });
});
