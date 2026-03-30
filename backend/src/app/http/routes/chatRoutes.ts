import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { sendChatJson, sendChatSse } from "../presenters/chatPresenter.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest } from "../../../shared/domain/errors.js";

const MAX_COLLECTION_PAGE_LIMIT = 100;
const DEFAULT_COLLECTION_PAGE_LIMIT = 50;
const DEFAULT_MESSAGE_WINDOW_LIMIT = 50;

export const chatSchema = z.object({
  query: z.string().min(1),
  stream: z.boolean(),
  conversationId: z.string().uuid().optional(),
  metadataFilter: z.record(z.unknown()).optional().refine(
    (val) => !val || Buffer.byteLength(JSON.stringify(val), "utf8") <= 16384,
    { message: "Metadata filter must be 16 KB or less" },
  ),
});

export const conversationParamsSchema = z.object({
  conversationId: z.string().uuid(),
});

export const collectionPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_COLLECTION_PAGE_LIMIT).default(DEFAULT_COLLECTION_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export const conversationWindowQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_COLLECTION_PAGE_LIMIT).default(DEFAULT_MESSAGE_WINDOW_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createChatRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);

  router.get("/history", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedQuery = collectionPageQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const page = await dependencies.chatHistoryService.listConversations(workspaceId, parsedQuery.data);
      res.status(200).json(page);
    } catch (error) {
      next(error);
    }
  });

  router.get("/history/:conversationId", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedParams = conversationParamsSchema.safeParse(req.params);
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
      const conversation = await dependencies.chatHistoryService.getConversation(
        workspaceId,
        conversationId,
        parsedQuery.data,
      );
      res.status(200).json(conversation);
    } catch (error) {
      next(error);
    }
  });

  router.post("/", workspaceSession, validateBody(chatSchema), async (req, res, next) => {
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
            metadataFilter: req.body.metadataFilter,
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
        metadataFilter: req.body.metadataFilter,
      });
      sendChatJson(res, result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
