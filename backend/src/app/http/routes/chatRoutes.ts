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
      const { workspaceId } = res.locals as { workspaceId: string };
      const conversations = await dependencies.chatHistoryService.listConversations(workspaceId);
      res.status(200).json({ conversations });
    } catch (error) {
      next(error);
    }
  });

  router.get("/history/:conversationId", requireApiToken(dependencies), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedParams = conversationParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const { conversationId } = parsedParams.data;
      const conversation = await dependencies.chatHistoryService.getConversation(
        workspaceId,
        conversationId,
      );
      res.status(200).json(conversation);
    } catch (error) {
      next(error);
    }
  });

  router.post("/", requireApiToken(dependencies), validateBody(chatSchema), async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      if (req.body.stream) {
        await sendChatSse(
          res,
          dependencies.chatService.streamAnswer({
            workspaceId,
            accountId,
            query: req.body.query,
            stream: req.body.stream,
            conversationId: req.body.conversationId,
          }),
        );
        return;
      }

      const result = await dependencies.chatService.answer({
        workspaceId,
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
