import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { sendChatJson, sendChatSse } from "../presenters/chatPresenter.js";
import { requireApiToken } from "../middleware/requireApiToken.js";
import { validateBody } from "../middleware/validate.js";

const chatSchema = z.object({
  query: z.string().min(1),
  stream: z.boolean(),
  conversationId: z.string().uuid().optional(),
});

export const createChatRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();

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
