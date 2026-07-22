import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";

/**
 * Bounded, content-free labels for a first-answer-chunk observation. `route` is
 * the answer path and `delivery_mode` how the first chunk reached the client;
 * both are small closed enums so the series stays low-cardinality.
 */
export type FirstAnswerChunkLabels = {
  route: string;
  delivery_mode: string;
};

type FirstAnswerChunkMetricsSink = Pick<MetricsRegistry, "observeHistogram" | "incrementCounter">;

/**
 * Records time-to-first-token for a streamed chat turn and compares it against
 * the perceived-performance budget. The histogram is the raw distribution; the
 * counter turns it into an SLO — a turn slower than the budget is *flagged*, not
 * failed or truncated, so operators can alert on "we're keeping people waiting"
 * without any effect on the turn itself. Values are latencies only; no prompt,
 * completion, or retrieved content ever reaches the metrics sink.
 */
export const observeFirstAnswerChunkLatency = (
  metrics: FirstAnswerChunkMetricsSink | null | undefined,
  timeToFirstTokenMs: number,
  labels: FirstAnswerChunkLabels,
): void => {
  metrics?.observeHistogram("chat_stream_first_answer_chunk_latency_ms", {
    help: "Latency from chat stream start to the first assistant answer chunk",
    labels,
    value: timeToFirstTokenMs,
  });
  if (timeToFirstTokenMs > CHAT_BEHAVIOR.perceivedPerformance.firstTokenTargetMs) {
    metrics?.incrementCounter("chat_stream_ttft_budget_exceeded_total", {
      help: "Streamed chat turns whose time-to-first-token exceeded the perceived-performance budget",
      labels,
    });
  }
};
