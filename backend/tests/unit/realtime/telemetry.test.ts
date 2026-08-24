import { describe, expect, it, vi } from "vitest";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";
import { createRealtimeTelemetry } from "../../../src/modules/realtime/infrastructure/realtimeTelemetry.js";

describe("realtime telemetry", () => {
  it("emits wired low-cardinality producer, transport, admission, gateway, and stream signals without identifiers or content", async () => {
    const metrics = new MetricsRegistry();
    const warn = vi.fn();
    let now = 10;
    const telemetry = createRealtimeTelemetry({ metrics, logger: { warn }, now: () => now++ });
    telemetry.producer.enqueue("accepted");
    telemetry.producer.publish("failed");
    telemetry.producer.queueDepth(4096, true);
    await telemetry.producer.flush(
      { batchSize: 2, pendingWorkspaces: 4096 },
      async () => ({ attempted: 2, failed: 1 }),
    );
    await telemetry.producer.flush(
      { batchSize: 1, pendingWorkspaces: 4096 },
      async () => ({ attempted: 1, failed: 1 }),
    );
    telemetry.transport.event("reconnect");
    telemetry.admission.event("rejected");
    telemetry.gateway.event("resync");
    telemetry.stream.event("closed");
    const rendered = metrics.renderPrometheus();
    expect(rendered).toContain('outcome="accepted"');
    expect(rendered).toContain('outcome="failed"');
    expect(rendered).toContain("radioso_realtime_producer_flush_duration_ms");
    expect(rendered).toContain("radioso_realtime_producer_pending_workspaces 4096");
    expect(rendered).toContain("radioso_realtime_producer_saturated 1");
    expect(rendered).not.toMatch(/4d7293c8|secret|document content/i);
    expect(warn).toHaveBeenCalledWith({
      component: "realtime-producer",
      outcome: "partial",
      attempted: 2,
      failed: 1,
    }, "realtime producer flush degraded");
    expect(warn).toHaveBeenCalledOnce();
  });
});
