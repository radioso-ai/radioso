import type { ProcessTurnResult, RoutineActionRequest, RoutineOperatorNoticeTemplate } from "@radioso/conversation-contract";

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

/** What the engine reports when a routine ends on a handoff terminal. */
export type RoutineHandoffEffect = NonNullable<ProcessTurnResult["handoff"]>;

/**
 * The payload every operator-notice action carries (`handoff.notify`, `completion.notify`): ids,
 * the reason code, the routine's declared slot values as-is, and the authored notice text when
 * the ending has some. One builder, so the two action types cannot drift apart.
 */
export const operatorNoticeActionPayload = (input: {
  conversationId: string;
  workspaceId: string;
  agentId: string;
  userMessageId: string;
  reason: string;
  routineId?: string;
  stepId?: string;
  /** The routine's declared slot values, forwarded to the operator notice as-is. */
  collected?: Record<string, unknown>;
  notice?: RoutineOperatorNoticeTemplate;
}): Record<string, unknown> => ({
  conversationId: input.conversationId,
  workspaceId: input.workspaceId,
  agentId: input.agentId,
  userMessageId: input.userMessageId,
  reason: input.reason,
  routineId: input.routineId,
  stepId: input.stepId,
  ...(input.collected ? { collected: input.collected } : {}),
  ...(input.notice?.subject || input.notice?.intro ? { notice: authoredNoticeText(input.notice) } : {}),
});

/** Only the text the author wrote; an absent field means the default for the ending's kind. */
const authoredNoticeText = (notice: RoutineOperatorNoticeTemplate): RoutineOperatorNoticeTemplate => ({
  ...(notice.subject ? { subject: notice.subject } : {}),
  ...(notice.intro ? { intro: notice.intro } : {}),
});

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
): { reason: "routine_handoff"; routineId: string; stepId: string } => ({
  reason: "routine_handoff",
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
