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
      },
      source: "backend",
    });

    expect(event).toMatchObject({
      eventName: "retrieval_settings.updated",
      workspaceId: "workspace-1",
      properties: {
        prompt: "[REDACTED]",
      },
    });
    expect(logger.info).toHaveBeenCalledOnce();
    expect(sink.emit).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "retrieval_settings.updated",
    }));
  });

  it("logs a subject id only when it has an id shape", async () => {
    const logger = createLogger();
    const service = new ProductAnalyticsService({ enabled: true, logger: logger as any });
    const visitorText = "where can I pray during the retreat";

    await service.track({
      eventName: "chat.citation_clicked",
      subjectType: "conversation",
      subjectId: visitorText,
      source: "frontend",
    });

    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(visitorText);
    expect(logger.info).toHaveBeenCalledWith(
      { analytics: { eventName: "chat.citation_clicked", subjectType: "conversation", source: "frontend" } },
      "product_analytics_event",
    );
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
      expect.objectContaining({ err: expect.objectContaining({ message: "analytics down" }), eventName: "chat.completed" }),
      "product_analytics_sink_failed",
    );
  });

  it("hands its sinks an error in the properties as its class and code, never its message", async () => {
    const visitorWords = "my daughter has asthma and needs the ground floor room";
    const emit = vi.fn<ProductAnalyticsSink["emit"]>().mockResolvedValue(undefined);
    const service = new ProductAnalyticsService({ enabled: true, logger: createLogger() as any, sinks: [{ emit }] });

    await service.track({
      eventName: "chat.failed",
      properties: { stream: true, failure: Object.assign(new TypeError(`Cannot read "${visitorWords}"`), { code: "ERR_INVALID_ARG_TYPE" }) },
    });

    const emitted = emit.mock.calls[0]?.[0];
    expect(JSON.stringify(emitted)).not.toContain(visitorWords);
    expect(emitted?.properties).toMatchObject({ stream: true, failure: { name: "TypeError", code: "ERR_INVALID_ARG_TYPE" } });
  });
});
