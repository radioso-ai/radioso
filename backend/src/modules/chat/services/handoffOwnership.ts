import type { ProcessTurnResult, RoutineActionRequest } from "@radioso/conversation-contract";

import { operatorNoticeActionPayload } from "./operatorNoticeAction.js";
import { HANDOFF_NOTIFY_ACTION_TYPE } from "./routines/contactRoutine.js";
import { SKILL_TURN_OUTCOME } from "./assistantTurnOutcomeTypes.js";
import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { ChatResponse } from "../types/chatResponses.js";
import { isHumanAuthoredMessageSource } from "../../../shared/domain/messageAuthorship.js";

// A teammate has engaged the thread once any message was authored by a human
// operator (a direct reply, or one sent on behalf of the AI).
export const isHumanAgentMessage = (message: { source?: string }): boolean =>
  isHumanAuthoredMessageSource(message.source);

export const suppressedHumanOwnedResponse = (
  session: PreparedSession,
  waitingMessage = "",
): ChatResponse => {
  const now = new Date().toISOString();
  return {
    conversationId: session.conversation.id,
    agentId: session.agent.id,
    agentName: session.agent.name,
    assistantMessageId: "",
    route: {
      type: "direct",
      reason: "social_only",
    },
    answer: waitingMessage,
    citations: [],
    answerSegments: [],
    suggestions: [],
    activitySummary: {
      status: "skipped",
      outcome: "human_owned_suppressed",
      retrievalSkipped: true,
    },
    activityTrace: {
      traceId: `ownership-suppressed-${session.conversation.id}`,
      startedAt: now,
      completedAt: now,
      totalDurationMs: 0,
      stages: [],
      links: [],
    },
    ownership: {
      state: "human_owned",
      suppressed: true,
    },
    // Nothing was generated, so nothing was assessed; the ids still anchor the slot to the turn.
    answerCoverage: {
      availability: "not_recorded",
      originatingTurnId: session.userMessage.id,
      originatingRequestId: session.userMessage.id,
    },
  };
};

/** What the engine reports when a routine ends by handing the conversation to a person. */
export type RoutineHandoffEffect = NonNullable<ProcessTurnResult["handoff"]>;

/** Why a routine requested a person: it reached an authored hand-off end, or its visitor got stuck (#1384). */
type RoutineHandoffReason = "routine_handoff" | "routine_stuck";

/** The ownership reason for a routine's hand-off, by the ending that raised it. */
const routineHandoffReason = (handoff: RoutineHandoffEffect): RoutineHandoffReason =>
  handoff.terminalKind === "stuck" ? "routine_stuck" : "routine_handoff";

/** Builds the `handoff.notify` action a retrieval-miss handoff emits. */
export const buildHandoffNotifyAction = (input: Parameters<typeof operatorNoticeActionPayload>[0] & {
  reason: "routine_handoff" | "retrieval_miss";
}): RoutineActionRequest => ({
  type: HANDOFF_NOTIFY_ACTION_TYPE,
  payload: operatorNoticeActionPayload(input),
});

/**
 * The ownership record and its audit event name the routine and step; the collected
 * values travel only on the notify action, so they are picked off here on purpose.
 */
export const routineHandoffOwnership = (
  handoff: RoutineHandoffEffect,
): { reason: RoutineHandoffReason; routineId: string; stepId: string } => ({
  reason: routineHandoffReason(handoff),
  routineId: handoff.routineId,
  stepId: handoff.stepId,
});

const shouldRequestRetrievalMissHandoff = (input: {
  session: PreparedSession;
  presentation: ChatPresentedAnswer;
}): boolean =>
  input.session.agent.handoffOnRetrievalMiss === true
  && input.presentation.skillOutcome === SKILL_TURN_OUTCOME.RETRIEVAL_NO_CONTEXT.outcome;

export const retrievalMissHandoffForTurn = (input: {
  session: PreparedSession;
  presentation: ChatPresentedAnswer;
  workspaceId: string;
  actions?: RoutineActionRequest[];
}): {
  ownershipHandoff: { reason: "retrieval_miss" } | null;
  actions?: RoutineActionRequest[];
} => {
  if (!shouldRequestRetrievalMissHandoff(input)) {
    return {
      ownershipHandoff: null,
      actions: input.actions,
    };
  }

  return {
    ownershipHandoff: { reason: "retrieval_miss" },
    actions: [
      ...(input.actions ?? []),
      buildHandoffNotifyAction({
        conversationId: input.session.conversation.id,
        workspaceId: input.workspaceId,
        agentId: input.session.agent.id,
        userMessageId: input.session.userMessage.id,
        reason: "retrieval_miss",
      }),
    ],
  };
};
