import type { Response } from "express";

import type { ChatCitation, ChatStreamEvent } from "../../../modules/chat/services/chatService.js";

export const sendChatJson = (
  res: Response,
  payload: {
    conversationId: string;
    answer: string;
    citations: ChatCitation[];
  },
): void => {
  res.status(200).json(payload);
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

      writeEvent("done", { citations: event.citations });
    }

    if (!res.writableEnded) {
      res.end();
    }
  })();
};
