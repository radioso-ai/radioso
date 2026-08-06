import type { Env } from "../../../app/config/env.js";
import { MetricsRegistry } from "../metrics/metricsRegistry.js";
import type { TelemetryEvent, TelemetrySink } from "./telemetrySink.js";

const numberLabel = (value: number | undefined): string => (typeof value === "number" ? String(Math.round(value)) : "unknown");

class MetricsTelemetrySink implements TelemetrySink {
  constructor(private readonly metricsRegistry: MetricsRegistry) {}

  async emit(event: TelemetryEvent): Promise<void> {
    this.metricsRegistry.incrementCounter("telemetry_events_total", {
      help: "Total emitted telemetry events.",
      labels: {
        event_type: event.eventType,
        severity: event.severity,
      },
    });

    if (event.eventType === "http.request.completed") {
      const labels = {
        method: event.tags?.method ?? "unknown",
        route: event.tags?.route ?? "unknown",
        status_code: numberLabel(event.metrics?.statusCode),
      };

      this.metricsRegistry.incrementCounter("http_requests_total", {
        help: "Total completed HTTP requests.",
        labels,
      });
      this.metricsRegistry.observeHistogram("http_request_duration_ms", {
        help: "Completed HTTP request durations in milliseconds.",
        labels,
        value: event.metrics?.durationMs ?? 0,
      });
      return;
    }

    if (event.eventType === "retrieval.pipeline.completed") {
      const labels = {
        rewrite_status: event.tags?.rewrite_status ?? "unknown",
        rerank_status: event.tags?.rerank_status ?? "unknown",
        fallback_applied: event.tags?.fallback_applied ?? "unknown",
        execution_surface: event.tags?.execution_surface ?? "unknown",
        execution_path: event.tags?.execution_path ?? "unknown",
      };

      this.metricsRegistry.incrementCounter("retrieval_pipeline_runs_total", {
        help: "Total retrieval pipeline executions.",
        labels,
      });
      this.metricsRegistry.observeHistogram("retrieval_final_context_count", {
        help: "Distribution of final context counts per retrieval execution.",
        labels,
        value: event.metrics?.finalContextCount ?? 0,
      });
      this.metricsRegistry.observeHistogram("retrieval_candidate_count", {
        help: "Distribution of normalized candidate counts per retrieval execution.",
        labels,
        value: event.metrics?.normalizedCandidateCount ?? 0,
      });
      return;
    }

    if (event.eventType === "webhook.send.delivery.completed") {
      this.metricsRegistry.incrementCounter("webhook_send_delivery_attempts_total", {
        help: "Total webhook.send delivery attempts by outcome.",
        labels: {
          outcome: event.tags?.outcome ?? "unknown",
          reason: event.tags?.reason ?? "unknown",
          terminal_kind: event.tags?.terminal_kind ?? "unknown",
        },
        value: event.metrics?.deliveryAttempt ?? 1,
      });
      return;
    }

    if (event.eventType.startsWith("document.worker.")) {
      const labels = {
        event_type: event.eventType,
        outcome: event.tags?.outcome ?? "unknown",
      };

      this.metricsRegistry.incrementCounter("document_worker_events_total", {
        help: "Total document worker telemetry events.",
        labels,
      });

      if (typeof event.metrics?.queuedJobCount === "number") {
        this.metricsRegistry.setGauge("document_worker_queue_jobs", {
          help: "Current queued document processing jobs.",
          labels: {
            state: "queued",
          },
          value: event.metrics.queuedJobCount,
        });
      }
      if (typeof event.metrics?.processingJobCount === "number") {
        this.metricsRegistry.setGauge("document_worker_queue_jobs", {
          help: "Current document processing jobs by state.",
          labels: {
            state: "processing",
          },
          value: event.metrics.processingJobCount,
        });
      }
      if (typeof event.metrics?.durationMs === "number") {
        this.metricsRegistry.observeHistogram("document_worker_job_duration_ms", {
          help: "Document worker job durations in milliseconds.",
          labels,
          value: event.metrics.durationMs,
        });
      }
      return;
    }

    if (event.eventType === "action.dispatch.queue_state") {
      // The operator-alertable signal for a stuck conversation-action outbox (the
      // contact-outbox incident this exists to catch): global counts and an age, no
      // per-workspace/per-conversation labels — low cardinality by construction.
      if (typeof event.metrics?.pendingCount === "number") {
        this.metricsRegistry.setGauge("action_dispatch_queue_pending", {
          help: "Current pending conversation-action outbox rows awaiting dispatch.",
          value: event.metrics.pendingCount,
        });
      }
      if (typeof event.metrics?.inProgressCount === "number") {
        this.metricsRegistry.setGauge("action_dispatch_queue_in_progress", {
          help: "Current in-progress (claimed) conversation-action outbox rows.",
          value: event.metrics.inProgressCount,
        });
      }
      if (typeof event.metrics?.oldestPendingAgeMs === "number") {
        this.metricsRegistry.setGauge("action_dispatch_oldest_pending_age_ms", {
          help: "Age in milliseconds of the oldest pending conversation-action outbox row.",
          value: event.metrics.oldestPendingAgeMs,
        });
      }
    }
  }
}

export interface TelemetrySinkBundle {
  metricsRegistry: MetricsRegistry | null;
  sinks: TelemetrySink[];
}

export const buildTelemetrySinks = (env: Pick<Env, "METRICS_ENABLED">): TelemetrySinkBundle => {
  if (!env.METRICS_ENABLED) {
    return {
      metricsRegistry: null,
      sinks: [],
    };
  }

  const metricsRegistry = new MetricsRegistry();
  return {
    metricsRegistry,
    sinks: [new MetricsTelemetrySink(metricsRegistry)],
  };
};
