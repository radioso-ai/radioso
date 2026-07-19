import type { Response } from "express";

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
  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  const writeEvent = (event: ChatStreamEvent) => {
    if (closed || res.writableEnded) {
      return;
    }

    if (!res.headersSent) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
    }

    if (event.type === "conversation") {
      res.write("event: conversation\n");
      res.write(`data: ${JSON.stringify({ conversationId: event.conversationId })}\n\n`);
      return;
    }

    if (event.type === "chunk") {
      res.write("event: chunk\n");
      res.write(`data: ${JSON.stringify({ text: event.text })}\n\n`);
      return;
    }

    if (event.type === "cancelled") {
      res.write("event: cancelled\n");
      res.write(`data: ${JSON.stringify({
        conversationId: event.conversationId,
        reason: event.reason,
        stage: event.stage,
      })}\n\n`);
      return;
    }

    if (event.type === "suggestions") {
      res.write("event: suggestions\n");
      res.write(`data: ${JSON.stringify({
        conversationId: event.conversationId,
        suggestions: event.suggestions,
      })}\n\n`);
      return;
    }

    if (event.type === "skill") {
      res.write("event: skill\n");
      res.write(`data: ${JSON.stringify({
        conversationId: event.conversationId,
        skillName: event.skillName,
        phase: event.phase,
        display: event.display,
        localizedTitle: event.localizedTitle,
        receipt: event.receipt,
      })}\n\n`);
      return;
    }

    const donePayload = presentChatPayload({
      conversationId: event.conversationId,
      agentId: event.agentId,
      agentName: event.agentName,
      assistantMessageId: event.assistantMessageId,
      route: event.route,
      answer: event.answer,
      citations: event.citations,
      answerSegments: event.answerSegments,
      suggestions: event.suggestions,
      activitySummary: event.activitySummary,
      activityTrace: event.activityTrace,
      turnTrace: event.turnTrace,
    }, options);
    res.write("event: done\n");
    res.write(`data: ${JSON.stringify({
      ...donePayload,
      // Forward the ownership ack so a streamed human-owned (suppressed) turn lets the
      // client drop the empty placeholder / render the waiting line, matching the
      // non-streaming response. Absent on normal turns, so this is a no-op for them.
      ...(event.ownership ? { ownership: event.ownership } : {}),
      ...(options.includeDebug && event.skill ? { skill: event.skill } : {}),
    })}\n\n`);
  };

  return (async () => {
    const iterator = events[Symbol.asyncIterator]();

    try {
      let next = await iterator.next();

      while (!next.done) {
        writeEvent(next.value);
        next = await iterator.next();
      }
    } finally {
      if (closed && typeof iterator.return === "function") {
        await iterator.return();
      }

      if (res.headersSent && !res.writableEnded) {
        res.end();
      }
    }
  })();
};
