import { describe, expect, it, vi } from "vitest";

import { TelemetryService } from "../../src/shared/observability/telemetry/telemetryService.js";
import { buildTelemetrySinks } from "../../src/shared/observability/telemetry/buildTelemetrySinks.js";
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

  it("counts webhook send delivery outcomes without high-cardinality labels", async () => {
    const { metricsRegistry, sinks } = buildTelemetrySinks({ METRICS_ENABLED: true });
    const service = new TelemetryService({
      enabled: true,
      environment: "test",
      logger: createLogger() as any,
      service: "radioso-api",
      sinks,
    });

    await service.emit({
      eventType: "webhook.send.delivery.completed",
      correlation: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        requestId: "request-1",
      },
      metrics: { attempt: 2, deliveryAttempt: 1 },
      metadata: {
        destinationRef: "33333333-3333-4333-8333-333333333333",
        routineId: "routine-1",
      },
      tags: {
        outcome: "retry",
        reason: "handler_error",
        terminal_kind: "complete",
      },
    });

    const metrics = metricsRegistry?.renderPrometheus() ?? "";
    expect(metrics).toContain("radioso_webhook_send_delivery_attempts_total");
    expect(metrics).toContain('outcome="retry"');
    expect(metrics).toContain('reason="handler_error"');
    expect(metrics).toContain('terminal_kind="complete"');
    expect(metrics).not.toContain("workspace-1");
    expect(metrics).not.toContain("33333333-3333-4333-8333-333333333333");
  });

  it("exposes action-outbox depth and oldest-pending-age as gauges an operator can alert on", async () => {
    const { metricsRegistry, sinks } = buildTelemetrySinks({ METRICS_ENABLED: true });
    const service = new TelemetryService({
      enabled: true,
      environment: "test",
      logger: createLogger() as any,
      service: "radioso-worker",
      sinks,
    });

    await service.emit({
      eventType: "action.dispatch.queue_state",
      metrics: { pendingCount: 4, inProgressCount: 1, oldestPendingAgeMs: 125_000 },
    });

    const metrics = metricsRegistry?.renderPrometheus() ?? "";
    expect(metrics).toContain("radioso_action_dispatch_queue_pending");
    expect(metrics).toContain("radioso_action_dispatch_queue_pending 4");
    expect(metrics).toContain("radioso_action_dispatch_queue_in_progress 1");
    expect(metrics).toContain("radioso_action_dispatch_oldest_pending_age_ms 125000");
    // Global counts only — no per-workspace/per-conversation label dimensions (no
    // `{...}` label block on any of the three series).
    expect(metrics).toMatch(/radioso_action_dispatch_queue_pending 4\b/);
    expect(metrics).toMatch(/radioso_action_dispatch_queue_in_progress 1\b/);
    expect(metrics).toMatch(/radioso_action_dispatch_oldest_pending_age_ms 125000\b/);
  });

  it("exposes low-cardinality workspace push channel health metrics", async () => {
    const { metricsRegistry, sinks } = buildTelemetrySinks({ METRICS_ENABLED: true });
    const service = new TelemetryService({
      enabled: true,
      environment: "test",
      logger: createLogger() as any,
      service: "radioso-api",
      sinks,
    });

    await service.emit({ eventType: "workspace_push.event_published", tags: { change_kind: "document.status_changed" } });
    await service.emit({ eventType: "workspace_push.publish_failed", tags: { change_kind: "document.status_changed" } });
    await service.emit({ eventType: "workspace_push.listener_notification_received" });
    await service.emit({ eventType: "workspace_push.listener_payload_parse_failed", severity: "warn" });
    await service.emit({ eventType: "workspace_push.listener_connected" });
    await service.emit({ eventType: "workspace_push.listener_disconnected", severity: "warn" });
    await service.emit({ eventType: "workspace_push.listener_reconnected" });
    await service.emit({ eventType: "workspace_push.subscriber_queue_overflow", severity: "warn" });
    await service.emit({ eventType: "workspace_push.sse_connection_opened", metrics: { connectionCount: 2 } });
    await service.emit({ eventType: "workspace_push.sse_connection_closed", metrics: { connectionCount: 1 } });

    const metrics = metricsRegistry?.renderPrometheus() ?? "";
    expect(metrics).toContain('radioso_workspace_push_events_published_total{change_kind="document.status_changed"} 1');
    expect(metrics).toContain('radioso_workspace_push_publish_failures_total{change_kind="document.status_changed"} 1');
    expect(metrics).toContain("radioso_workspace_push_listener_notifications_total 1");
    expect(metrics).toContain("radioso_workspace_push_listener_payload_parse_failures_total 1");
    expect(metrics).toContain("radioso_workspace_push_listener_connects_total 1");
    expect(metrics).toContain("radioso_workspace_push_listener_disconnects_total 1");
    expect(metrics).toContain("radioso_workspace_push_listener_reconnects_total 1");
    expect(metrics).toContain("radioso_workspace_push_subscriber_queue_overflows_total 1");
    expect(metrics).toContain("radioso_workspace_push_sse_connections 1");
    expect(metrics).not.toContain("workspace-a");
    expect(metrics).not.toContain("document-257");
  });
});
