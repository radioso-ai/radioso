import type { Response } from "express";

import { initializeSse, sendSseIterable, writeSseEvent } from "./ssePresenter.js";

import type {
  AnswerSegment,
  ChatCitation,
  ChatRoute,
  ChatStreamEvent,
  ChatSuggestion,
} from "../../../modules/chat/contracts/index.js";
import type { ActivitySummary, ActivityTrace } from "../../../modules/retrieval/public.js";
import type { TurnTraceEnvelope } from "../../../modules/chat/services/turnTraceEnvelope.js";

interface ChatDiagnosticPayload {
  route: ChatRoute;
  activitySummary: ActivitySummary;
  activityTrace: ActivityTrace;
  // Conversation spine as the root span with capability traces as typed leaves.
  // Optional during transition (turns answered before the envelope existed omit it).
  turnTrace?: TurnTraceEnvelope;
}

type ChatPayload = {
  conversationId?: string;
  agentId?: string;
  agentName?: string;
  assistantMessageId?: string;
  route: ChatRoute;
  answer: string;
  skillOutcome?: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  activitySummary: ActivitySummary;
  activityTrace: ActivityTrace;
  turnTrace?: TurnTraceEnvelope;
};

export type PresentedChatPayload =
  Omit<ChatPayload, "route" | "activitySummary" | "activityTrace" | "turnTrace"> & {
    debug?: ChatDiagnosticPayload;
  };

export const presentChatPayload = (payload: ChatPayload, options: { includeDebug?: boolean } = {}): PresentedChatPayload => {
  const {
    route,
    activitySummary,
    activityTrace,
    turnTrace,
    ...publicPayload
  } = payload;

  return {
    ...publicPayload,
    ...(options.includeDebug ? { debug: { route, activitySummary, activityTrace, turnTrace } } : {}),
  };
};

export const sendChatJson = (
  res: Response,
  payload: ChatPayload,
  options: { includeDebug?: boolean } = {},
): void => {
  res.status(200).json(presentChatPayload(payload, options));
};

export const sendChatSse = (
  res: Response,
  events: AsyncIterable<ChatStreamEvent>,
  options: { includeDebug?: boolean } = {},
): Promise<void> => {
  const writeEvent = async (event: ChatStreamEvent) => {
    if (res.writableEnded) {
      return;
    }

    initializeSse(res);

    if (event.type === "conversation") {
      await writeSseEvent(res, "conversation", { conversationId: event.conversationId });
      return;
    }

    if (event.type === "status") {
      await writeSseEvent(res, "status", { stage: event.stage });
      return;
    }

    if (event.type === "chunk") {
      await writeSseEvent(res, "chunk", { text: event.text });
      return;
    }

    if (event.type === "cancelled") {
      await writeSseEvent(res, "cancelled", {
        conversationId: event.conversationId,
        reason: event.reason,
        stage: event.stage,
      });
      return;
    }

    if (event.type === "suggestions") {
      await writeSseEvent(res, "suggestions", {
        conversationId: event.conversationId,
        suggestions: event.suggestions,
      });
      return;
    }

    if (event.type === "skill") {
      await writeSseEvent(res, "skill", {
        conversationId: event.conversationId,
        skillName: event.skillName,
        phase: event.phase,
        display: event.display,
        localizedTitle: event.localizedTitle,
        receipt: event.receipt,
      });
      return;
    }

    const donePayload = presentChatPayload({
      conversationId: event.conversationId,
      agentId: event.agentId,
      agentName: event.agentName,
      assistantMessageId: event.assistantMessageId,
      route: event.route,
      answer: event.answer,
      skillOutcome: event.skillOutcome,
      citations: event.citations,
      answerSegments: event.answerSegments,
      suggestions: event.suggestions,
      activitySummary: event.activitySummary,
      activityTrace: event.activityTrace,
      turnTrace: event.turnTrace,
    }, options);
    await writeSseEvent(res, "done", {
      ...donePayload,
      // Forward the ownership ack so a streamed human-owned (suppressed) turn lets the
      // client drop the empty placeholder / render the waiting line, matching the
      // non-streaming response. Absent on normal turns, so this is a no-op for them.
      ...(event.ownership ? { ownership: event.ownership } : {}),
      ...(options.includeDebug && event.skill ? { skill: event.skill } : {}),
    });
  };

  return sendSseIterable(res, events, writeEvent);
};
