import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import type { PendingClarificationResolution } from "./pendingClarificationResolver.js";

export type ClarificationMetricDecision =
  | "asked"
  | "offered"
  | "auto_picked"
  | "suppressed"
  | "not_clarified"
  | "mapped"
  | "offer_accepted_alternative"
  | "offer_accepted"
  | "offer_declined"
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
  | "page_capture"
  | "all_senses_kept"
  | "label_fallback"
  | "compatible_facets"
  | "redundant_sources"
  | "phrasing_fallback"
  | "offer_first";

const METRIC_REASONS: ReadonlySet<ClarificationMetricReason> = new Set([
  "ask",
  "soft_band",
  "clear_margin",
  "loop_guard",
  "priority",
  "suppressed",
  "page_capture",
  "all_senses_kept",
  "label_fallback",
  "compatible_facets",
  "redundant_sources",
  "phrasing_fallback",
  "offer_first",
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
      return { decision: "suppressed", reason: asMetricReason(reason, "suppressed") };
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

/**
 * The decision a resolved pending clarification counts as. A reply to a routine's offer counts as
 * accepted, declined, or ignored; a retrieval-sense offer keeps its accepted-alternative and
 * ignored labels. Null when no pending row was resolved this turn.
 */
export const clarificationResolutionMetric = (
  resolution: PendingClarificationResolution,
): { surface: string; decision: ClarificationMetricDecision } | null => {
  if (!resolution.resolvedPending) {
    return null;
  }
  if (resolution.kind === "retrieval_sense") {
    return {
      surface: "retrieval_sense",
      decision: resolution.offerOutcome === "accepted_alternative" ? "offer_accepted_alternative" : "mapped",
    };
  }
  if (resolution.kind === "routine_activation") {
    return { surface: "routine_activation", decision: resolution.mappingOutcome ? "offer_accepted" : "mapped" };
  }
  const surface = resolution.source === "retrieval_sense" ? "retrieval_sense" : "routine_activation";
  if (surface === "routine_activation" && resolution.mappingOutcome) {
    return { surface, decision: `offer_${resolution.mappingOutcome}` };
  }
  return { surface, decision: resolution.offerOutcome === "ignored" ? "offer_ignored" : (resolution.outcome ?? "declined") };
};
