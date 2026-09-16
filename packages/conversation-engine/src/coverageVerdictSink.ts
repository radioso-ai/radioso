import type {
  AnswerCoverageAssessment,
  ConversationCoverageVerdictSink,
  ConversationTraceStage,
  Directive,
  DirectiveMatch,
  ProcessTurnInput,
  ProcessTurnResult,
  ProcessTurnStreamInput,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";

import { attemptRoutineActivation, RoutineActivationFailure } from "./routineActivation.js";
import { coverageCriteriaMatches } from "./steering.js";
import { stage, timedStage } from "./traceStages.js";

type AssessedCoverage = Extract<AnswerCoverageAssessment, { availability: "assessed" }>;

/** The trace is operator-facing; retain only a bounded failure category here. */
const coverageRoutineFailureKind = (
  error: unknown,
): "routine_selection_failed" | "routine_resume_failed" | "type_error" | "activation_error" => {
  if (error instanceof RoutineActivationFailure) {
    return error.phase === "selection" ? "routine_selection_failed" : "routine_resume_failed";
  }
  return error instanceof TypeError ? "type_error" : "activation_error";
};

const coverageRoutineFailureCauseType = (error: unknown): string => {
  if (error instanceof RoutineActivationFailure) {
    return error.cause instanceof Error ? error.cause.name : typeof error.cause;
  }
  return error instanceof Error ? error.name : typeof error;
};

const criteriaMatches = (
  criteria: NonNullable<Directive["coverageCriteria"]>,
  assessment: AssessedCoverage,
): boolean => coverageCriteriaMatches(criteria, assessment);

export interface CoverageVerdictSinkDeps {
  /**
   * The turn's full engine input. `AttemptRoutineInput` is a structural subset of
   * both `ProcessTurnInput` and `ProcessTurnStreamInput`, so this spreads straight
   * into the routine-activation call the same way `prepareTurn` used to.
   */
  attemptRoutineInput: ProcessTurnInput | ProcessTurnStreamInput;
  /** The turn compose runs against — steering and staged context already final. */
  composeTurn: TurnContext;
  /** Directives without a coverage gate, unioned with the criteria-eligible ones at report time. */
  legacyDirectives: readonly Directive[];
  /** Every coverage directive that passed the contextual matcher, unfiltered by classification. */
  coverageDirectiveMatches: readonly DirectiveMatch[];
  /** The turn's final resolved steering, used only to re-derive applicability for id-less directives. */
  directiveSteering: readonly SteeringRule[];
  /** Directive ids that survived conflict resolution into the rendered steering set. */
  appliedCoverageDirectiveIds: ReadonlySet<string>;
  /** Mutated in place: stages this sink pushes land on the turn's own trace spine. */
  stages: ConversationTraceStage[];
  composeStartedAt: number;
}

interface CoverageVerdictSinkHandle {
  sink: ConversationCoverageVerdictSink;
  /** The post-evidence routine's own result, populated once `report` yields the turn. */
  getRoutineResult: () => ProcessTurnResult | undefined;
}

/**
 * Builds the compose-time coverage verdict sink (#1260): the one port a
 * retrieval-style skill calls, from inside compose, to hand the engine its
 * parsed answer-head classification before releasing any answer text. This is
 * what `prepareTurn` used to do before compose ran at all — directive
 * applicability, coverage routine candidate evaluation and activation,
 * reaction recording — moved to run only once the verdict actually exists.
 */
export const createCoverageVerdictSink = (deps: CoverageVerdictSinkDeps): CoverageVerdictSinkHandle => {
  let reported = false;
  let routineResult: ProcessTurnResult | undefined;

  const sink: ConversationCoverageVerdictSink = {
    async report({ assessment }) {
      if (reported) {
        // A skill reporting twice in one turn is a bug on its side; the sink must
        // never let that turn a safe answer into a failed one.
        deps.stages.push(stage({
          id: "answer_coverage_head_repeat",
          kind: "answer_coverage_head",
          status: "fallback",
          outputs: { reason: "already_reported" },
        }));
        return { decision: "proceed" };
      }
      reported = true;

      deps.stages.push(timedStage(deps.composeStartedAt, Date.now(), {
        id: "answer_coverage_head",
        kind: "answer_coverage_head",
        status: assessment.availability === "assessed" ? "applied" : "fallback",
        outputs: {
          availability: assessment.availability,
          ...(assessment.producer ? { producer: assessment.producer } : {}),
          ...(assessment.availability === "assessed"
            ? { coverage: assessment.coverage, reason: assessment.reason }
            : {}),
        },
      }));

      if (assessment.availability !== "assessed") {
        return { decision: "proceed" };
      }

      // Everything below reads routine/activation ports the host wired in. A
      // rejection anywhere in this branch — not just inside `attemptRoutineActivation`
      // — must degrade to a normal answer, never propagate out of `report()` and
      // turn a fully generated good answer into a failed turn.
      try {
        const assessedComposeTurn: TurnContext = {
          ...deps.composeTurn,
          metadata: { ...(deps.composeTurn.metadata ?? {}), answerCoverage: assessment },
        };

        const coverageEligibleMatches = deps.coverageDirectiveMatches.filter((match) =>
          match.directive.coverageCriteria !== undefined
          && criteriaMatches(match.directive.coverageCriteria, assessment));
        const coverageEligibleDirectives = coverageEligibleMatches.map((match) => match.directive);

        const activator = deps.attemptRoutineInput.coverageRoutineActivator;
        const routineStore = deps.attemptRoutineInput.routineStore;
        const completedCoverageRoutineIds = routineStore?.loadCompleted
          ? (await routineStore.loadCompleted({ sessionId: deps.attemptRoutineInput.sessionId })).map((state) => state.routineId)
          : [];
        const coverageRoutineCandidates = activator
          ? activator.evaluateCandidates({ turn: assessedComposeTurn, suppressedRoutineIds: completedCoverageRoutineIds })
          : [];
        // The pre-retrieval routine pass can yield an active routine so grounding
        // answers the current message. This pass must not resume or replace that
        // active state a second time.
        const activeRoutine = routineStore
          ? await routineStore.loadActive({ sessionId: deps.attemptRoutineInput.sessionId })
          : null;

        let postEvidenceRoutine: ProcessTurnResult | null = null;
        let evaluationFailed = false;
        if (activator && activeRoutine?.status !== "active") {
          try {
            postEvidenceRoutine = await attemptRoutineActivation({
              ...deps.attemptRoutineInput,
              // Coverage-gated activation receives only the directives whose criteria
              // have been evaluated for this signal. It must not reintroduce an
              // ineligible authored rule through the routine resume path.
              directives: [...deps.legacyDirectives, ...coverageEligibleDirectives],
              routineActivator: activator,
              ...(activator.reentryGate ? { routineReentryGate: activator.reentryGate } : {}),
              turnContext: assessedComposeTurn,
              inputEventAlreadyAppended: true,
            });
          } catch (error) {
            evaluationFailed = true;
            deps.stages.push(stage({
              id: "answer_coverage_routine_activation",
              kind: "answer_coverage_routine_activation",
              status: "fallback",
              outputs: {
                availability: "failed",
                failureKind: coverageRoutineFailureKind(error),
                causeType: coverageRoutineFailureCauseType(error),
              },
            }));
          }
        }

        if (deps.attemptRoutineInput.coverageReactionRecorder && !evaluationFailed) {
          try {
            const directiveReactions = deps.coverageDirectiveMatches.map((match, index) => {
              const renderedInSteering = match.directive.id
                ? deps.appliedCoverageDirectiveIds.has(match.directive.id)
                : match.renderInSteering !== false && deps.directiveSteering.some((rule) =>
                  rule.source === "directive" && rule.action === match.directive.action,
                );
              const criteriaMet = match.directive.coverageCriteria === undefined
                || criteriaMatches(match.directive.coverageCriteria, assessment);
              const applied = renderedInSteering && criteriaMet;
              return {
                reactionKey: `directive:${match.directive.id ?? match.directive.name}:${index}`,
                ...(match.directive.id ? { directiveId: match.directive.id } : {}),
                decision: applied ? "applied" as const : "suppressed" as const,
                reasonCode: applied
                  ? "coverage_criteria_applied"
                  : !renderedInSteering
                    ? "coverage_steering_conflict"
                    : "coverage_criteria_not_met",
              };
            });
            const routineExecution = postEvidenceRoutine?.routineExecution;
            const offeredRoutineIds = new Set(postEvidenceRoutine?.routineClarificationRoutineIds ?? []);
            const activeRoutineKeepsControl = activeRoutine?.status === "active";
            const routineReactions = coverageRoutineCandidates.map((candidate) => {
              const activated = routineExecution?.routineId === candidate.routineId;
              const offered = offeredRoutineIds.has(candidate.routineId);
              return {
                reactionKey: `routine:${candidate.routineId}:${candidate.decision}`,
                routineId: candidate.routineId,
                ...(activated && routineExecution?.executionId ? { routineExecutionId: routineExecution.executionId } : {}),
                decision: activated ? "activated" as const
                  : activeRoutineKeepsControl ? "suppressed" as const
                  : candidate.decision === "suppressed" ? "suppressed" as const
                  : offered ? "offered" as const : "skipped" as const,
                reasonCode: activated ? "coverage_criteria_activated"
                  : activeRoutineKeepsControl ? "active_routine_keeps_control"
                  : candidate.decision === "suppressed" ? candidate.reasonCode
                  : offered ? "coverage_activation_offered" : "coverage_activation_not_selected",
              };
            });
            await deps.attemptRoutineInput.coverageReactionRecorder.record({
              assessment,
              evaluationState: "evaluated",
              reactions: [...directiveReactions, ...routineReactions],
            });
          } catch {
            // Trace/persistence extensions remain observational and cannot fail a turn.
            deps.stages.push(stage({
              id: "answer_coverage_reaction_recording",
              kind: "answer_coverage_reaction_recording",
              status: "fallback",
              outputs: { availability: "failed" },
            }));
          }
        }

        if (postEvidenceRoutine) {
          routineResult = postEvidenceRoutine;
          return { decision: "yield_turn" };
        }
        return { decision: "proceed" };
      } catch (error) {
        deps.stages.push(stage({
          id: "answer_coverage_routine_activation",
          kind: "answer_coverage_routine_activation",
          status: "fallback",
          outputs: {
            availability: "failed",
            failureKind: coverageRoutineFailureKind(error),
            causeType: coverageRoutineFailureCauseType(error),
          },
        }));
        return { decision: "proceed" };
      }
    },
  };

  return { sink, getRoutineResult: () => routineResult };
};
