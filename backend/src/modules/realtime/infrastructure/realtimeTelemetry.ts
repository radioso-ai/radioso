import { traceOperation } from "../../../shared/observability/tracing/operations.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";

type ProducerOutcome = "accepted" | "coalesced" | "dropped";
type TransportOutcome = "connected" | "reconnect" | "failed";
type AdmissionOutcome = "accepted" | "rejected" | "degraded";
type GatewayOutcome = "subscribed" | "released" | "resync";
type StreamOutcome = "opened" | "ready" | "slow" | "closed";

const metric = (metrics: MetricsRegistry | undefined, name: string, outcome: string): void => {
  metrics?.incrementCounter(name, { help: `Realtime ${name.replaceAll("_", " ")}`, labels: { outcome } });
};

const flushOutcome = (result: { attempted: number; failed: number }) => result.attempted === 0
  ? "skipped"
  : result.failed === 0
    ? "accepted"
    : result.failed === result.attempted ? "failed" : "partial";

export const createRealtimeTelemetry = (input: {
  metrics?: MetricsRegistry | null;
  logger?: Pick<AppLogger, "warn">;
  now?: () => number;
}) => {
  const metrics = input.metrics ?? undefined;
  const now = input.now ?? performance.now.bind(performance);
  let lastProducerWarningAt = Number.NEGATIVE_INFINITY;
  const warnProducer = (fields: { outcome: string; attempted: number; failed: number }, message: string) => {
    const warningAt = now();
    if (warningAt - lastProducerWarningAt < 30_000) return;
    lastProducerWarningAt = warningAt;
    input.logger?.warn({ component: "realtime-producer", ...fields }, message);
  };

  return {
    producer: {
      enqueue: (outcome: ProducerOutcome) => metric(metrics, "realtime_producer_enqueue_total", outcome),
      publish: (outcome: "accepted" | "failed") => metric(metrics, "realtime_producer_publish_total", outcome),
      queueDepth: (pendingWorkspaces: number, saturated: boolean) => {
        metrics?.setGauge("realtime_producer_pending_workspaces", {
          help: "Realtime producer pending workspace count",
          value: pendingWorkspaces,
        });
        metrics?.setGauge("realtime_producer_saturated", {
          help: "Whether the realtime producer workspace bound is saturated",
          value: saturated ? 1 : 0,
        });
      },
      flush: async (
        flushInput: { batchSize: number; pendingWorkspaces: number },
        run: () => Promise<{ attempted: number; failed: number }>,
      ) => {
        const startedAt = now();
        try {
          const result = await traceOperation({
            name: "realtime.producer.flush",
            attributes: {
              "realtime.flush.batch_size": flushInput.batchSize,
              "realtime.flush.pending_workspaces": flushInput.pendingWorkspaces,
            },
            run,
            resultAttributes: (value) => ({
              "realtime.flush.attempted": value.attempted,
              "realtime.flush.failed": value.failed,
              "realtime.flush.outcome": flushOutcome(value),
            }),
          });
          const outcome = flushOutcome(result);
          metric(metrics, "realtime_producer_flush_total", outcome);
          metrics?.observeHistogram("realtime_producer_flush_batch_size", {
            help: "Realtime producer attempted envelopes per flush",
            value: result.attempted,
          });
          metrics?.observeHistogram("realtime_producer_flush_duration_ms", {
            help: "Realtime producer flush duration in milliseconds",
            value: Math.max(0, now() - startedAt),
          });
          if (result.failed > 0) {
            warnProducer({
              outcome,
              attempted: result.attempted,
              failed: result.failed,
            }, "realtime producer flush degraded");
          }
          return result;
        } catch (error) {
          metric(metrics, "realtime_producer_flush_total", "failed");
          warnProducer({
            outcome: "failed",
            attempted: 0,
            failed: flushInput.batchSize,
          }, "realtime producer flush failed");
          throw error;
        }
      },
    },
    transport: { event: (outcome: TransportOutcome) => metric(metrics, "realtime_transport_events_total", outcome) },
    admission: { event: (outcome: AdmissionOutcome) => metric(metrics, "realtime_admission_events_total", outcome) },
    gateway: { event: (outcome: GatewayOutcome) => metric(metrics, "realtime_gateway_events_total", outcome) },
    stream: { event: (outcome: StreamOutcome) => metric(metrics, "realtime_stream_events_total", outcome) },
  };
};

export type RealtimeTelemetry = ReturnType<typeof createRealtimeTelemetry>;
