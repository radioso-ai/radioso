import type { Response } from "express";

import type { AnswerSegment, ChatCitation } from "../../../modules/chat/services/answerPresentationService.js";
import type { ChatStreamEvent } from "../../../modules/chat/services/chatService.js";
import type { ConversationMode } from "../../../modules/settings/domain/retrievalSettings.js";
import type { ChatRoute, ChatSuggestion, ConversationModeMetadata } from "../../../modules/chat/types/chatResponses.js";
import type { RetrievalInfo, RetrievalTrace } from "../../../modules/retrieval/public.js";

export const sendChatJson = (
  res: Response,
  payload: {
    conversationId?: string;
    assistantMessageId?: string;
    route: ChatRoute;
    answer: string;
    citations?: ChatCitation[];
    answerSegments?: AnswerSegment[];
    suggestions?: ChatSuggestion[];
    conversationMode: ConversationMode;
    conversationModeMetadata: ConversationModeMetadata;
    retrievalInfo: RetrievalInfo;
    retrievalTrace: RetrievalTrace;
  },
): void => {
  res.status(200).json(payload);
};

export const sendChatSse = (
  res: Response,
  events: AsyncIterable<ChatStreamEvent>,
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

    if (event.type === "suggestions") {
      res.write("event: suggestions\n");
      res.write(`data: ${JSON.stringify({
        conversationId: event.conversationId,
        suggestions: event.suggestions,
        conversationModeMetadata: event.conversationModeMetadata,
      })}\n\n`);
      return;
    }

    res.write("event: done\n");
    res.write(`data: ${JSON.stringify({
      conversationId: event.conversationId,
      assistantMessageId: event.assistantMessageId,
      route: event.route,
      answer: event.answer,
      citations: event.citations,
      answerSegments: event.answerSegments,
      suggestions: event.suggestions,
      conversationMode: event.conversationMode,
      conversationModeMetadata: event.conversationModeMetadata,
      retrievalInfo: event.retrievalInfo,
      retrievalTrace: event.retrievalTrace,
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
