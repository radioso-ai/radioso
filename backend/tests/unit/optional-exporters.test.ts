import { describe, expect, it, vi } from "vitest";

import { PosthogAnalyticsSink } from "../../src/integrations/posthog/posthogAnalyticsSink.js";
import { SentryIncidentSink } from "../../src/integrations/sentry/sentryIncidentSink.js";
import { ProductAnalyticsService } from "../../src/shared/analytics/productAnalyticsService.js";
import { AuditEventAnalyticsSink } from "../../src/shared/analytics/auditEventAnalyticsSink.js";
import { IncidentReportingService } from "../../src/shared/incidents/incidentReportingService.js";
import { AuditIncidentSink } from "../../src/shared/incidents/auditIncidentSink.js";
import { InMemoryAuditEventRepository, createAuditService } from "../support/fakes.js";

describe("optional exporters", () => {
  it("swallows PostHog exporter failures after first-party persistence", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const repository = new InMemoryAuditEventRepository();
    const auditService = createAuditService(repository);
    const service = new ProductAnalyticsService({
      enabled: true,
      logger: logger as any,
      sinks: [
        new AuditEventAnalyticsSink(auditService),
        new PosthogAnalyticsSink({
          apiKey: "posthog-key",
          host: "https://app.posthog.com",
          fetchImpl: vi.fn().mockResolvedValue(new Response("nope", { status: 503 })) as any,
        }),
      ],
    });

    const event = await service.track({
      eventName: "chat.completed",
      workspaceId: "workspace-1",
      subjectType: "conversation",
      subjectId: "conversation-1",
    });

    expect(event?.eventName).toBe("chat.completed");
    expect(repository.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "product.analytics",
      }),
    ]));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "chat.completed",
      }),
      "product_analytics_sink_failed",
    );
  });

  it("swallows Sentry exporter failures after first-party incident capture", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const repository = new InMemoryAuditEventRepository();
    const auditService = createAuditService(repository);
    const service = new IncidentReportingService({
      enabled: true,
      environment: "test",
      logger: logger as any,
      service: "radioso-api",
      version: "test",
      sinks: [
        new AuditIncidentSink(auditService),
        new SentryIncidentSink({
          dsn: "https://public@example.ingest.sentry.io/123456",
          fetchImpl: vi.fn().mockResolvedValue(new Response("nope", { status: 502 })) as any,
        }),
      ],
    });

    const event = await service.report({
      incidentType: "http.request.unhandled",
      message: "boom",
      severity: "error",
      correlation: {
        workspaceId: "workspace-1",
      },
    });

    expect(event?.incidentType).toBe("http.request.unhandled");
    expect(repository.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "incident.recorded",
      }),
    ]));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentType: "http.request.unhandled",
      }),
      "incident_sink_failed",
    );
  });

  it("formats PostHog and Sentry exporter requests using HTTP-only adapters", async () => {
    const posthogFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const sentryFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const posthogSink = new PosthogAnalyticsSink({
      apiKey: "posthog-key",
      host: "https://app.posthog.com",
      fetchImpl: posthogFetch as any,
    });
    const sentrySink = new SentryIncidentSink({
      dsn: "https://public@example.ingest.sentry.io/123456",
      fetchImpl: sentryFetch as any,
    });

    await posthogSink.emit({
      eventName: "chat.citation_clicked",
      timestamp: "2026-04-22T10:00:00.000Z",
      workspaceId: "workspace-1",
      subjectType: "conversation",
      subjectId: "conversation-1",
      source: "frontend",
    });
    await sentrySink.record({
      incidentType: "worker.failure",
      timestamp: "2026-04-22T10:00:00.000Z",
      severity: "error",
      service: "radioso-worker",
      environment: "test",
      message: "worker exploded",
    });

    expect(posthogFetch).toHaveBeenCalledWith(
      "https://app.posthog.com/capture/",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(JSON.parse(String(posthogFetch.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({
      event: "chat.citation_clicked",
      distinct_id: "conversation-1",
    }));

    expect(sentryFetch).toHaveBeenCalledWith(
      "https://example.ingest.sentry.io/api/123456/envelope/",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(String(sentryFetch.mock.calls[0]?.[1]?.body)).toContain("\"worker.failure\"");
    expect(String(sentryFetch.mock.calls[0]?.[1]?.body)).toContain("\"worker exploded\"");
  });
});
