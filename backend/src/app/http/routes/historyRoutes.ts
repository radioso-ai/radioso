import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import {
  collectionPageQuerySchema,
  conversationParamsSchema,
  historyContactParamsSchema,
  conversationWindowQuerySchema,
  historySearchParamsSchema,
  historyItemsPageQuerySchema,
} from "./conversationRouteSchemas.js";

type HistoryRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  "assistantHistoryService" | "documentSearchHistoryService"
>;

export const createHistoryRoutes = (dependencies: HistoryRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const historyRead = requireWorkspacePermission(dependencies, "workspace.history.read");

  router.get("/", workspaceSession, historyRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedQuery = historyItemsPageQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const page = await dependencies.assistantHistoryService.listItems(workspaceId, parsedQuery.data);
      res.status(200).json(page);
    } catch (error) {
      next(error);
    }
  });

  router.get("/chat", workspaceSession, historyRead, async (req, res, next) => {
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

  router.get("/search", workspaceSession, historyRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedQuery = collectionPageQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const page = await dependencies.documentSearchHistoryService.listHistory(workspaceId, parsedQuery.data);
      res.status(200).json(page);
    } catch (error) {
      next(error);
    }
  });

  router.get("/contact", workspaceSession, historyRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedQuery = historyItemsPageQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const page = await dependencies.assistantHistoryService.listContacts(workspaceId, parsedQuery.data);
      res.status(200).json(page);
    } catch (error) {
      next(error);
    }
  });

  router.get("/contact/:requestId", workspaceSession, historyRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedParams = historyContactParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const parsedQuery = conversationWindowQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const contact = await dependencies.assistantHistoryService.getContactRequest(
        workspaceId,
        parsedParams.data.requestId,
        parsedQuery.data,
      );
      res.status(200).json(contact);
    } catch (error) {
      next(error);
    }
  });

  router.get("/search/:searchId", workspaceSession, historyRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedParams = historySearchParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const search = await dependencies.documentSearchHistoryService.getHistory(workspaceId, parsedParams.data.searchId);
      res.status(200).json(search);
    } catch (error) {
      next(error);
    }
  });

  router.get("/chat/:conversationId", workspaceSession, historyRead, async (req, res, next) => {
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

  router.get("/:conversationId", workspaceSession, historyRead, async (req, res, next) => {
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
