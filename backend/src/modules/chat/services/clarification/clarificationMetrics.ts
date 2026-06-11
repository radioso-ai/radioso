import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";

export type ClarificationMetricDecision =
  | "asked"
  | "auto_picked"
  | "suppressed"
  | "mapped"
  | "declined"
  | "expired";

export const recordClarificationDecision = (
  metricsRegistry: MetricsRegistry,
  input: { surface: string; decision: ClarificationMetricDecision },
): void => {
  metricsRegistry.incrementCounter("clarification_decisions_total", {
    help: "Clarification decisions by surface and decision.",
    labels: {
      surface: input.surface,
      decision: input.decision,
    },
  });
};
