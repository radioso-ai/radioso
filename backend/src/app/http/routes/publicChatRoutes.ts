import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { sendChatSse } from "../presenters/chatPresenter.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { resolveAnonymousSession } from "../middleware/resolveAnonymousSession.js";
import { anonymousRateLimiter } from "../middleware/anonymousRateLimiter.js";
import { validateBody } from "../middleware/validate.js";
import { collectionPageQuerySchema, conversationWindowQuerySchema } from "./conversationRouteSchemas.js";

const localeHintSchema = z.string().trim().max(35);

export const anonymousChatSchema = z.object({
  message: z.string().min(1).optional(),
  stream: z.boolean().default(false),
  conversationId: z.string().uuid().optional(),
  startConversation: z.boolean().optional(),
  userExpectedLocale: localeHintSchema.optional(),
  inputMetadata: z.object({
    method: z.enum(["typed", "suggestion_click"]),
    suggestionSourceMessageId: z.string().uuid().optional(),
  }).superRefine((value, ctx) => {
    if (value.method === "suggestion_click" && !value.suggestionSourceMessageId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "suggestionSourceMessageId is required for suggestion_click",
        path: ["suggestionSourceMessageId"],
      });
    }
  }).optional(),
}).superRefine((value, ctx) => {
  if (!value.message && !value.startConversation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "message is required unless startConversation is true",
      path: ["message"],
    });
  }
  if (value.startConversation && value.conversationId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "startConversation may only be used for brand-new conversations",
      path: ["conversationId"],
    });
  }
});

export const publicConversationParamsSchema = z.object({
  conversationId: z.string().uuid(),
});

export const createPublicChatRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const sessionMiddleware = resolveAnonymousSession(
    dependencies.workspaceRepository,
    dependencies.env.WEBSITE_EMBED_SECRET,
  );
  const rateLimitAnonymousChat = anonymousRateLimiter(dependencies);

  // POST /api/v1/public/chat/:token — send a message
  router.post(
    "/:token",
    sessionMiddleware,
    rateLimitAnonymousChat,
    validateBody(anonymousChatSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, anonymousSessionId, sourceChannel, sourceOrigin } = res.locals as {
          workspaceId: string;
          anonymousSessionId: string;
          sourceChannel: string | null;
          sourceOrigin: string | null;
        };

        if (req.body.startConversation) {
          const bootstrap = await dependencies.assistantChatService.answer({
            workspaceId,
            startConversation: true,
            stream: false,
            sourceChannel,
            anonymousSessionId,
            sourceOrigin,
            userExpectedLocale: req.body.userExpectedLocale,
          });
          if (!bootstrap) {
            res.status(204).end();
            return;
          }
          res.status(200).json(bootstrap);
          return;
        }

        const input = {
          workspaceId,
          message: req.body.message!,
          stream: req.body.stream,
          userExpectedLocale: req.body.userExpectedLocale,
          conversationId: req.body.conversationId,
          inputMetadata: req.body.inputMetadata,
          sourceChannel,
          anonymousSessionId,
          sourceOrigin,
        };

        if (input.stream) {
          await sendChatSse(res, dependencies.assistantChatService.streamAnswer(input));
        } else {
          const result = await dependencies.assistantChatService.answer(input);
          res.status(200).json(result);
        }
      } catch (error) {
        next(error);
      }
    },
  );

  // GET /api/v1/public/chat/:token — list conversations for this anonymous session
  router.get("/:token", sessionMiddleware, async (req, res, next) => {
    try {
      const { workspaceId, workspaceName, anonymousSessionId } = res.locals as {
        workspaceId: string;
        workspaceName: string;
        anonymousSessionId: string;
      };
      const parsedQuery = collectionPageQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const page = await dependencies.chatHistoryService.listAnonymousConversations(
        workspaceId,
        anonymousSessionId,
        parsedQuery.data,
      );

      res.status(200).json({
        workspaceName,
        assistantBootstrapActive: Boolean((res.locals as { assistantBootstrapActive?: boolean }).assistantBootstrapActive),
        ...page,
      });
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
      const parsedQuery = conversationWindowQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const { conversationId } = parsedParams.data;

      // Verify the conversation belongs to this anonymous session, not just the workspace
      const conversation = await dependencies.conversationRepository.findByIdAndAnonymousSession(
        conversationId,
        res.locals.workspaceId as string,
        anonymousSessionId,
      );
      if (!conversation) {
        res.status(404).json({ error: { code: "not_found", message: "Conversation not found" } });
        return;
      }

      const detail = await dependencies.chatHistoryService.getConversation(
        conversation.workspaceId,
        conversationId,
        parsedQuery.data,
      );
      res.status(200).json(detail);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
