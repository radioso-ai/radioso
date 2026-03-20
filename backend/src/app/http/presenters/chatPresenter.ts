import type { Response } from "express";

import type { AnswerSegment, ChatCitation } from "../../../modules/chat/services/answerPresentationService.js";
import type { ChatStreamEvent } from "../../../modules/chat/services/chatService.js";
import type { RetrievalInfo } from "../../../modules/retrieval/services/retrievalInfoPresenter.js";

export const sendChatJson = (
  res: Response,
  payload: {
    conversationId: string;
    answer: string;
    citations?: ChatCitation[];
    answerSegments?: AnswerSegment[];
    retrievalInfo: RetrievalInfo;
    source?: "retrieval" | "inference";
  },
): void => {
  res.status(200).json({ ...payload, source: payload.source ?? "retrieval" });
};

export const sendChatSse = (
  res: Response,
  events: AsyncIterable<ChatStreamEvent>,
): Promise<void> => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  const writeEvent = (event: string, data: Record<string, unknown>) => {
    if (closed || res.writableEnded) {
      return;
    }

    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  return (async () => {
    for await (const event of events) {
      if (event.type === "conversation") {
        writeEvent("conversation", { conversationId: event.conversationId });
        continue;
      }

      if (event.type === "chunk") {
        writeEvent("chunk", { text: event.text });
        continue;
      }

      writeEvent("done", {
        conversationId: event.conversationId,
        answer: event.answer,
        citations: event.citations,
        answerSegments: event.answerSegments,
        retrievalInfo: event.retrievalInfo,
        source: event.source ?? "retrieval",
      });
    }

    if (!res.writableEnded) {
      res.end();
    }
  })();
};
