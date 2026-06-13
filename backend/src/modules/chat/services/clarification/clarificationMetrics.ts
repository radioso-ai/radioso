import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";

export type ClarificationMetricDecision =
  | "asked"
  | "offered"
  | "auto_picked"
  | "suppressed"
  | "mapped"
  | "offer_accepted_alternative"
  | "offer_ignored"
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
