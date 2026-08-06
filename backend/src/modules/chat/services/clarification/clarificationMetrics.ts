import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";

export type ClarificationMetricDecision =
  | "asked"
  | "offered"
  | "auto_picked"
  | "suppressed"
  | "not_clarified"
  | "mapped"
  | "offer_accepted_alternative"
  | "offer_ignored"
  | "declined"
  | "expired";

/**
 * Bounded reason label recorded alongside a decision so operators can compute
 * ask-rate (asked / sum of decisions per surface) and see *why* a turn resolved
 * without asking. Enumerable by design — never free text, never content.
 */
export type ClarificationMetricReason =
  | "ask"
  | "soft_band"
  | "clear_margin"
  | "loop_guard"
  | "priority"
  | "suppressed"
  | "label_fallback"
  | "compatible_facets"
  | "redundant_sources"
  | "phrasing_fallback";

const METRIC_REASONS: ReadonlySet<ClarificationMetricReason> = new Set([
  "ask",
  "soft_band",
  "clear_margin",
  "loop_guard",
  "priority",
  "suppressed",
  "label_fallback",
  "compatible_facets",
  "redundant_sources",
  "phrasing_fallback",
]);

const asMetricReason = (
  reason: string | undefined,
  fallback: ClarificationMetricReason,
): ClarificationMetricReason =>
  reason && METRIC_REASONS.has(reason as ClarificationMetricReason)
    ? (reason as ClarificationMetricReason)
    : fallback;

/**
 * Maps a clarification trace stage's `decision`/`reason` outputs to the bounded
 * metric shape. Returns `null` for stages that are not ask-rate relevant (e.g. a
 * plain `none` skip with no compatible-facet reason). Pure so it is unit-testable
 * away from the trace plumbing.
 */
export const clarificationDecisionMetric = (
  decision: string,
  reason: string | undefined,
): { decision: ClarificationMetricDecision; reason?: ClarificationMetricReason } | null => {
  switch (decision) {
    case "asked":
      return { decision: "asked", reason: asMetricReason(reason, "ask") };
    case "offered":
      return { decision: "offered", reason: asMetricReason(reason, "soft_band") };
    case "auto_picked":
      return { decision: "auto_picked", reason: asMetricReason(reason, "clear_margin") };
    case "suppressed":
      return { decision: "suppressed", reason: "suppressed" };
    case "none":
      return reason === "compatible_facets" || reason === "redundant_sources"
        ? { decision: "not_clarified", reason }
        : null;
    default:
      return null;
  }
};

export const recordClarificationDecision = (
  metricsRegistry: MetricsRegistry,
  input: { surface: string; decision: ClarificationMetricDecision; reason?: ClarificationMetricReason },
): void => {
  metricsRegistry.incrementCounter("clarification_decisions_total", {
    help: "Clarification decisions by surface, decision, and reason.",
    labels: {
      surface: input.surface,
      decision: input.decision,
      // Empty-value labels are dropped by the registry, so resolution outcomes
      // that carry no reason stay a single low-cardinality series.
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
};
