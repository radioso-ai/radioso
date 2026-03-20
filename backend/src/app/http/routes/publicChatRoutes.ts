import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { resolveAnonymousSession } from "../middleware/resolveAnonymousSession.js";
import { anonymousRateLimiter } from "../middleware/anonymousRateLimiter.js";
import { validateBody } from "../middleware/validate.js";

const anonymousChatSchema = z.object({
  query: z.string().min(1),
  stream: z.boolean().default(false),
  conversationId: z.string().uuid().optional(),
});

const publicConversationParamsSchema = z.object({
  conversationId: z.string().uuid(),
});

export const createPublicChatRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const sessionMiddleware = resolveAnonymousSession(dependencies.workspaceRepository);

  // POST /api/v1/public/chat/:token — send a message
  router.post(
    "/:token",
    sessionMiddleware,
    anonymousRateLimiter,
    validateBody(anonymousChatSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, anonymousSessionId } = res.locals as {
          workspaceId: string;
          anonymousSessionId: string;
        };

        const input = {
          workspaceId,
          query: req.body.query,
          stream: req.body.stream,
          conversationId: req.body.conversationId,
          sourceChannel: "anonymous",
          anonymousSessionId,
        };

        if (input.stream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");

          for await (const event of dependencies.chatService.streamAnswer(input)) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          res.end();
        } else {
          const result = await dependencies.chatService.answer(input);
          res.status(200).json(result);
        }
      } catch (error) {
        next(error);
      }
    },
  );

  // GET /api/v1/public/chat/:token — list conversations for this anonymous session
  router.get("/:token", sessionMiddleware, async (_req, res, next) => {
    try {
      const { workspaceId, anonymousSessionId } = res.locals as {
        workspaceId: string;
        anonymousSessionId: string;
      };

      const conversations = await dependencies.conversationRepository.listByAnonymousSession(
        workspaceId,
        anonymousSessionId,
      );

      const summaries = await Promise.all(
        conversations.map(async (conversation) => {
          const messages = await dependencies.messageRepository.listByConversationId(conversation.id);
          const preview = messages.length > 0
            ? messages[messages.length - 1].content.slice(0, 140)
            : null;
          return {
            id: conversation.id,
            sourceChannel: conversation.sourceChannel,
            preview,
            messageCount: messages.length,
            createdAt: conversation.createdAt.toISOString(),
            updatedAt: conversation.updatedAt.toISOString(),
          };
        }),
      );

      res.status(200).json({ conversations: summaries });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/public/chat/:token/history/:conversationId — get conversation detail
  router.get("/:token/history/:conversationId", sessionMiddleware, async (req, res, next) => {
    try {
      const { anonymousSessionId } = res.locals as { anonymousSessionId: string };
      const parsedParams = publicConversationParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const { conversationId } = parsedParams.data;

      // Verify the conversation belongs to this anonymous session, not just the workspace
      const conversation = await dependencies.conversationRepository.findByIdAndAnonymousSession(
        conversationId,
        anonymousSessionId,
      );
      if (!conversation) {
        res.status(404).json({ error: { code: "not_found", message: "Conversation not found" } });
        return;
      }

      const detail = await dependencies.chatHistoryService.getConversation(conversation.workspaceId, conversationId);
      res.status(200).json(detail);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
