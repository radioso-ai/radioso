import type { MetricsRegistry } from "../../observability/metrics/metricsRegistry.js";
import type { CacheAccounting, LlmProviderMetadata, ProviderCacheCapability } from "./providerTypes.js";

type Metrics = Pick<MetricsRegistry, "incrementCounter" | "observeHistogram">;
type Outcome = "succeeded" | "failed" | "cancelled" | "aborted";
type TimingBoundary = "provider_invocation" | "adapter_first_text";

const providers = new Set(["openai", "openai-compatible", "gemini", "claude"]);
const capabilities = new Set<ProviderCacheCapability>(["unsupported", "implicit", "explicit_checkpoint"]);
const surfaces = new Set(["assistant", "api", "embed", "mcp", "operator", "worker"]);
const operations = new Set([
  "answer", "direct_answer", "turn_interpretation", "response_language_detection", "query_rewrite", "rerank",
]);

const bounded = (value: string, allowed: Set<string>): string => allowed.has(value) ? value : "other";
const finiteDuration = (value: number): number | undefined =>
  Number.isFinite(value) && value >= 0 ? value : undefined;

const labelsFor = (input: {
  metadata: LlmProviderMetadata;
  surface: string;
  operation: string;
  accounting?: CacheAccounting;
  outcome: Outcome;
}): Record<string, string> => ({
  surface: bounded(input.surface, surfaces),
  operation: bounded(input.operation, operations),
  provider: bounded(input.metadata.provider, providers),
  // Never place a configured model identifier in metrics. The provider family is
  // enough to split the current fixed provider groups without cardinality risk.
  model_group: bounded(input.metadata.provider, providers),
  capability: capabilities.has(input.metadata.cacheCapability ?? "unsupported")
    ? input.metadata.cacheCapability ?? "unsupported"
    : "unsupported",
  accounting_state: input.accounting?.state ?? "unknown",
  outcome: input.outcome,
});

/** Best-effort bounded instrumentation for internal inference only. */
export const recordCacheInferenceTelemetry = (
  metrics: Metrics | null | undefined,
  input: {
    metadata: LlmProviderMetadata;
    surface: string;
    operation: string;
    accounting?: CacheAccounting;
    outcome: Outcome;
    durationMs?: number;
    timingBoundary: TimingBoundary;
    recordRequest?: boolean;
  },
): void => {
  if (!metrics) return;
  try {
    const labels = labelsFor(input);
    if (input.recordRequest !== false) {
      metrics.incrementCounter("llm_input_cache_requests_total", {
        help: "Inference requests classified by cache capability and accounting availability.",
        labels,
      });
    }
    const durationMs = input.durationMs === undefined ? undefined : finiteDuration(input.durationMs);
    if (durationMs !== undefined) {
      metrics.observeHistogram("llm_inference_timing_duration_ms", {
        help: "Adapter-observable inference timing; not user-visible TTFT.",
        labels: { ...labels, timing_boundary: input.timingBoundary },
        value: durationMs,
      });
    }
    if (input.accounting?.readInputTokens !== undefined) {
      metrics.observeHistogram("llm_input_cache_read_input_tokens", {
        help: "Provider-reported cache-read input tokens when available.",
        labels,
        value: input.accounting.readInputTokens,
      });
    }
    if (input.accounting?.writeInputTokens !== undefined) {
      metrics.observeHistogram("llm_input_cache_write_input_tokens", {
        help: "Provider-reported cache-write input tokens when available.",
        labels,
        value: input.accounting.writeInputTokens,
      });
    }
  } catch {
    // Telemetry is observational and cannot alter a generation or stream.
  }
};
