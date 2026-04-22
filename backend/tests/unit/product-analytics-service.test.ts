import { describe, expect, it, vi } from "vitest";

import { ProductAnalyticsService } from "../../src/shared/analytics/productAnalyticsService.js";
import type { ProductAnalyticsSink } from "../../src/shared/analytics/productAnalyticsSink.js";

const createLogger = () => ({
  info: vi.fn(),
  error: vi.fn(),
});

describe("ProductAnalyticsService", () => {
  it("tracks redacted analytics events and emits them to sinks", async () => {
    const sink: ProductAnalyticsSink = {
      emit: vi.fn().mockResolvedValue(undefined),
    };
    const logger = createLogger();
    const service = new ProductAnalyticsService({
      enabled: true,
      logger: logger as any,
      sinks: [sink],
    });

    const event = await service.track({
      eventName: "retrieval_settings.updated",
      workspaceId: "workspace-1",
      subjectType: "settings",
      subjectId: "workspace-1",
      properties: {
        prompt: "private",
        conversationMode: "guided",
      },
      source: "backend",
    });

    expect(event).toMatchObject({
      eventName: "retrieval_settings.updated",
      workspaceId: "workspace-1",
      properties: {
        prompt: "[REDACTED]",
        conversationMode: "guided",
      },
    });
    expect(logger.info).toHaveBeenCalledOnce();
    expect(sink.emit).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "retrieval_settings.updated",
    }));
  });

  it("logs sink failures but does not throw", async () => {
    const logger = createLogger();
    const service = new ProductAnalyticsService({
      enabled: true,
      logger: logger as any,
      sinks: [
        {
          emit: vi.fn().mockRejectedValue(new Error("analytics down")),
        },
      ],
    });

    await expect(service.track({
      eventName: "chat.completed",
    })).resolves.toBeTruthy();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: "analytics down", eventName: "chat.completed" }),
      "product_analytics_sink_failed",
    );
  });
});
