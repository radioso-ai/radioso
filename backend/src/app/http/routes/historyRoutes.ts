import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import {
  collectionPageQuerySchema,
  conversationParamsSchema,
  conversationWindowQuerySchema,
} from "./conversationRouteSchemas.js";

export const createHistoryRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);

  router.get("/", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedQuery = collectionPageQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const page = await dependencies.assistantHistoryService.listConversations(workspaceId, parsedQuery.data);
      res.status(200).json(page);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:conversationId", workspaceSession, async (req, res, next) => {
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
      const conversation = await dependencies.assistantHistoryService.getConversation(
        workspaceId,
        parsedParams.data.conversationId,
        parsedQuery.data,
      );
      res.status(200).json(conversation);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
