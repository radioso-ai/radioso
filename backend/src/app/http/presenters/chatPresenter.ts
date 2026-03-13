import type { Response } from "express";

export const sendChatJson = (
  res: Response,
  payload: {
    conversationId: string;
    answer: string;
    citations: Array<{ documentId: string; chunkId: string; title: string }>;
  },
): void => {
  res.status(200).json(payload);
};

export const sendChatSse = (
  res: Response,
  payload: {
    conversationId: string;
    answer: string;
    citations: Array<{ documentId: string; chunkId: string; title: string }>;
  },
): void => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write(`event: conversation\n`);
  res.write(`data: ${JSON.stringify({ conversationId: payload.conversationId })}\n\n`);

  for (const chunk of payload.answer.match(/.{1,32}/g) ?? []) {
    res.write(`event: chunk\n`);
    res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
  }

  res.write(`event: done\n`);
  res.write(`data: ${JSON.stringify({ citations: payload.citations })}\n\n`);
  res.end();
};
