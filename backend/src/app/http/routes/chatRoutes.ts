import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { sendChatJson, sendChatSse } from "../presenters/chatPresenter.js";
import { requireApiToken } from "../middleware/requireApiToken.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest } from "../../../shared/domain/errors.js";

const chatSchema = z.object({
  query: z.string().min(1),
  stream: z.boolean(),
  conversationId: z.string().uuid().optional(),
});

const conversationParamsSchema = z.object({
  conversationId: z.string().uuid(),
});

export const createChatRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/history", requireApiToken(dependencies), async (_req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const conversations = await dependencies.chatHistoryService.listConversations(accountId);
      res.status(200).json({ conversations });
    } catch (error) {
      next(error);
    }
  });

  router.get("/history/:conversationId", requireApiToken(dependencies), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const parsedParams = conversationParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const { conversationId } = parsedParams.data;
      const conversation = await dependencies.chatHistoryService.getConversation(
        accountId,
        conversationId,
      );
      res.status(200).json(conversation);
    } catch (error) {
      next(error);
    }
  });

  router.post("/", requireApiToken(dependencies), validateBody(chatSchema), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      if (req.body.stream) {
        await sendChatSse(
          res,
          dependencies.chatService.streamAnswer({
            accountId,
            query: req.body.query,
            stream: req.body.stream,
            conversationId: req.body.conversationId,
          }),
        );
        return;
      }

      const result = await dependencies.chatService.answer({
        accountId,
        query: req.body.query,
        stream: req.body.stream,
        conversationId: req.body.conversationId,
      });
      sendChatJson(res, result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
