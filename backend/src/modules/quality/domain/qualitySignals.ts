import type {
  QualityActionFilter,
  QualityFeedbackValue,
  QualitySignalId,
  QualitySkillStatus,
  QualityTriageState,
} from "../contracts/index.js";

/**
 * Latency floor for the `slow_responses` signal. Reads against
 * `messages.total_latency_ms` (true turn wall time), not retrieval-pipeline time.
 */
export const SLOW_RESPONSE_MIN_LATENCY_MS = 10_000;

/**
 * Skill statuses that count as a failure. Capability-agnostic on purpose, so the
 * signal surfaces failures from the whole engine surface rather than just retrieval.
 */
export const SKILL_FAILURE_STATUSES: readonly QualitySkillStatus[] = ["failed"];

/** Feedback values that count as negative. */
export const NEGATIVE_FEEDBACK_VALUES: readonly QualityFeedbackValue[] = ["down"];

/**
 * Triage states still in the active backlog. Backlog counts include only these, so
 * resolved and dismissed turns drain out of what the operator is asked to look at.
 */
export const QUALITY_SIGNAL_ACTIVE_TRIAGE_STATES: readonly QualityTriageState[] = [
  "open",
  "acknowledged",
];

/**
 * The slice of a skill catalog entry that signal classification depends on. Narrower
 * than the full catalog entry on purpose: this module needs outcome names and their
 * grounding flag, nothing else.
 */
export interface QualityOutcomeCatalogEntry {
  name: string;
  outcomes?: readonly { name: string; groundedAnswer?: boolean }[];
}

/** Source of the skill outcomes signal classification is derived from. */
export interface QualityOutcomeCatalogPort {
  listOutcomeCatalog(workspaceId: string): Promise<readonly QualityOutcomeCatalogEntry[]>;
}

/**
 * The `(skillName, outcome)` tuples on either side of the grounding question, derived
 * from structured catalog metadata rather than outcome-name matching so the definition
 * stays correct as skills evolve and across locales.
 */
export interface GroundedOutcomeTuples {
  /** Outcomes the catalog marks as having produced a grounded answer. */
  grounded: QualityActionFilter[];
  /** Outcomes the catalog marks as having failed to ground an answer. */
  gaps: QualityActionFilter[];
}

/**
 * Splits catalog outcomes into grounded answers and grounding gaps.
 *
 * An absent `groundedAnswer` flag is neither: `clarification_needed` deliberately omits
 * it because asking a clarifying question is not a failure to ground, and is not a
 * grounded answer either. Such turns fall outside the grounded-rate denominator
 * entirely rather than being scored on a question they never attempted to answer.
 *
 * Entries the capability policy marks `forbidden` are included. A turn that already ran
 * is still a turn: dropping its outcomes would silently shrink the denominator whenever
 * a capability is revoked, which is exactly the kind of dishonest rate this surface exists
 * to avoid.
 */
export const resolveGroundedOutcomeTuples = (
  skills: readonly QualityOutcomeCatalogEntry[],
): GroundedOutcomeTuples => {
  const grounded: QualityActionFilter[] = [];
  const gaps: QualityActionFilter[] = [];

  for (const skill of skills) {
    for (const outcome of skill.outcomes ?? []) {
      if (outcome.groundedAnswer === true) {
        grounded.push({ skillName: skill.name, outcome: outcome.name });
      } else if (outcome.groundedAnswer === false) {
        gaps.push({ skillName: skill.name, outcome: outcome.name });
      }
    }
  }

  return { grounded, gaps };
};

/**
 * A signal's meaning, expressed over quality concepts. Deliberately free of SQL: the
 * query layer decides how each shape becomes a predicate, so this module can be reused
 * by any reader of the turn population.
 */
export type QualitySignalPredicate =
  | { kind: "feedback"; values: readonly QualityFeedbackValue[] }
  | { kind: "actions"; actions: readonly QualityActionFilter[] }
  | { kind: "minLatencyMs"; minTotalLatencyMs: number }
  | { kind: "skillStatuses"; statuses: readonly QualitySkillStatus[] };

/**
 * The single definition of what each operator signal means. Both the windowed rate and
 * the backlog chip resolve through here, so a chip's count can never disagree with the
 * rows that clicking it produces.
 */
export const resolveQualitySignalPredicate = (
  signal: QualitySignalId,
  tuples: GroundedOutcomeTuples,
): QualitySignalPredicate => {
  switch (signal) {
    case "negative_feedback":
      return { kind: "feedback", values: NEGATIVE_FEEDBACK_VALUES };
    case "grounding_gaps":
      return { kind: "actions", actions: tuples.gaps };
    case "slow_responses":
      return { kind: "minLatencyMs", minTotalLatencyMs: SLOW_RESPONSE_MIN_LATENCY_MS };
    case "skill_failures":
      return { kind: "skillStatuses", statuses: SKILL_FAILURE_STATUSES };
  }
};
