import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { answerCoverageHeadParseOutcome } from "../../../shared/domain/steeringRule.js";
import type { AnswerCoverageAssessment } from "../contracts/answerCoverage.js";
import type { TurnDeclineReason } from "./assistantTurnOutcomeTypes.js";
import type { GroundedAnswerEnvelope } from "./groundedAnswerEnvelope.js";
import type { CommittedDeclineOutcome, GroundingSummary } from "./groundingAssertions.js";

const isEnvelopeDecline = (outcome: GroundedAnswerEnvelope["outcome"]): boolean =>
  outcome === "no_support" || outcome === "out_of_scope";

/**
 * The retrieval answer's content-free counters: how its grounding assertions came out, how
 * its coverage head parsed and what the host decided, and every way a draft became a
 * decline. Every label is a closed value set; no answer text, query, or id is recorded.
 */
export class RetrievalAnswerMetrics {
  constructor(private readonly metrics?: Pick<MetricsRegistry, "incrementCounter"> | null) {}

  groundingOutcome(
    summary: GroundingSummary,
    envelope: Pick<GroundedAnswerEnvelope, "outcome">,
    stream: boolean,
  ): void {
    const protocol = summary.parseStatus === "valid_v2"
      ? "v2"
      : summary.parseStatus === "legacy_v1"
        ? "v1"
        : summary.parseStatus === "missing"
          ? "missing"
          : "malformed";
    const reason = summary.parseStatus !== "valid_v2"
      ? "parse_failure"
      : summary.invalidSourceCount > 0
        ? "invalid_index"
        : summary.assertionMismatch
          ? "mismatch"
          : isEnvelopeDecline(envelope.outcome) && summary.verdict !== "no_support"
            ? "invalid_no_support"
            : summary.claimCount === 0 && summary.verdict !== "no_support"
              ? "anchor_free"
              : summary.unsourcedClaimCount > 0
                ? "unsourced"
                : "complete";
    this.metrics?.incrementCounter("chat_grounding_assertion_outcomes_total", {
      help: "Computed chat grounding assertion outcomes",
      labels: {
        protocol,
        verdict: summary.verdict,
        reason,
        stream: String(stream),
        // Content-free: why the turn declined, or `none` when it did not decline.
        decline: summary.declineReason ?? "none",
      },
    });
  }

  groundingGateBound(declineReason: TurnDeclineReason): void {
    this.metrics?.incrementCounter("chat_grounding_assertion_outcomes_total", {
      help: "Computed chat grounding assertion outcomes",
      labels: {
        protocol: "v2",
        verdict: "no_support",
        reason: "gate_bound",
        stream: "true",
        decline: declineReason,
      },
    });
  }

  blankDecline(
    outcome: CommittedDeclineOutcome,
    declineReason: TurnDeclineReason,
    stream: boolean,
  ): void {
    this.metrics?.incrementCounter("chat_grounding_assertion_outcomes_total", {
      help: "Computed chat grounding assertion outcomes",
      labels: {
        protocol: "v2",
        verdict: "no_support",
        reason: "blank_decline",
        stream: String(stream),
        decline: declineReason,
        outcome,
      },
    });
  }

  unsupportedAnswerDecline(declineReason: TurnDeclineReason, stream: boolean): void {
    this.metrics?.incrementCounter("chat_grounding_assertion_outcomes_total", {
      help: "Computed chat grounding assertion outcomes",
      labels: {
        protocol: "v2",
        verdict: "no_support",
        reason: "unsupported_answer",
        stream: String(stream),
        decline: declineReason,
      },
    });
  }

  /**
   * Bounded-label counters for the answer-head parse outcome and the host's
   * proceed/yield decision (#1260). Records nothing when `decision` is
   * absent — the coverage verdict sink was never wired for this turn, so
   * there is no host decision to attribute an outcome to.
   */
  coverageHeadOutcome(
    assessment: AnswerCoverageAssessment,
    decision: "proceed" | "yield_turn" | undefined,
  ): void {
    if (!decision) {
      return;
    }
    const parseOutcome = answerCoverageHeadParseOutcome(assessment);
    this.metrics?.incrementCounter("chat_answer_coverage_head_parse_total", {
      help: "Answer envelope head parse outcome before the host decides",
      labels: { outcome: parseOutcome },
    });
    this.metrics?.incrementCounter("chat_answer_coverage_head_decision_total", {
      help: "Host decision (proceed or yield the turn) after the answer coverage head verdict",
      labels: { decision },
    });
  }
}
