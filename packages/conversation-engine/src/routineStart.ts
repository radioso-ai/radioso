import type {
  AttemptRoutineInput,
  ClarificationCandidate,
  ConversationTraceStage,
  RoutineActivationResult,
  RoutineStartOffer,
} from "@radioso/conversation-contract";

import { clarificationStage } from "./clarification.js";

/** The surface a routine activation's clarifications and offers are saved and traced under. */
export const ROUTINE_ACTIVATION_SURFACE = "routine_activation";

/** An offer stays acceptable for as long as an activation question does. */
const OFFER_TTL_MS = 30 * 60 * 1000;

type RoutineActivateOutcome = Extract<RoutineActivationResult, { kind: "activate" }>;

/**
 * An Offer-first routine starts only on a direct request. Any other activation (an automatic
 * routine, a direct invocation, an explicit claim, an accepted offer) carries no Offer-first
 * start mode and starts as it always has.
 */
export const offersInsteadOfStarting = (activation: RoutineActivateOutcome): boolean =>
  activation.startMode === "offer" && activation.directRequest !== true;

/**
 * The clarification stage of a ranked pick that starts its routine. An Offer-first routine
 * started by a clear request says so, which tells it apart from one an author left automatic.
 */
export const startedRoutineStage = (
  stage: ConversationTraceStage,
  activation: RoutineActivateOutcome,
): ConversationTraceStage =>
  activation.startMode === "offer" && activation.directRequest === true
    ? { ...stage, outputs: { ...stage.outputs, startedBy: "direct_request" } }
    : stage;

const pickedCandidate = (activation: RoutineActivateOutcome): ClarificationCandidate => {
  const decision = activation.decisionMetadata?.decision;
  if (decision && "candidate" in decision) {
    return decision.candidate;
  }
  return {
    id: activation.routineId,
    label: activation.routineId,
    confidence: 1,
    payload: { routineId: activation.routineId, ...(activation.variables ? { variables: activation.variables } : {}) },
  };
};

/**
 * Offers the picked routine instead of starting it. The pending offer holds the routine and the
 * values the ranker read from this message, so accepting it starts the routine holding them. A
 * conversation is offered a routine once: when it already had the offer, or the host keeps no
 * pending row or offer memory, nothing is offered and the routine waits for a direct request.
 * Returns the stage the turn records and, when the answer ends with one, the offer.
 */
export const offerRoutine = async (
  input: AttemptRoutineInput,
  activation: RoutineActivateOutcome,
): Promise<{ stage: ConversationTraceStage; offer?: RoutineStartOffer }> => {
  const candidate = pickedCandidate(activation);
  const consideredCandidates = activation.decisionMetadata?.consideredCandidates ?? [candidate];
  const held = (reason: string) => {
    const stage = clarificationStage({
      surface: ROUTINE_ACTIVATION_SURFACE,
      decision: { kind: "none" },
      consideredCandidates,
      reason,
    });
    return { stage: { ...stage, outputs: { ...stage.outputs, chosenCandidateId: candidate.id } } };
  };
  const { clarificationStore, routineOfferMemory } = input;
  if (!clarificationStore || !routineOfferMemory) {
    return held("offer_unavailable");
  }
  const offered = await routineOfferMemory.loadOffered({ sessionId: input.sessionId });
  if (offered.includes(activation.routineId)) {
    return held("already_offered");
  }
  await clarificationStore.save({
    sessionId: input.sessionId,
    source: ROUTINE_ACTIVATION_SURFACE,
    originalQuery: input.inputEvent.content,
    mode: "offer",
    candidates: [candidate],
    status: "pending",
    expiresAt: new Date(Date.now() + OFFER_TTL_MS),
  });
  await routineOfferMemory.recordOffered({ sessionId: input.sessionId, routineId: activation.routineId });
  return {
    stage: clarificationStage({
      surface: ROUTINE_ACTIVATION_SURFACE,
      decision: { kind: "offer", candidate },
      consideredCandidates,
      reason: "offer_first",
    }),
    offer: {
      routineId: activation.routineId,
      label: candidate.label,
      ...(candidate.description ? { description: candidate.description } : {}),
    },
  };
};
