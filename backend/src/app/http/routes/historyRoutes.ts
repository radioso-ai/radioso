import { Router, type Response } from "express";

import type { AppDependencies } from "../../server/types.js";
import type { ConversationErasureActor } from "../../../modules/privacy/public.js";
import {
  resolveActivityReadScope,
  type ConversationActivityReadScope,
} from "../../../modules/conversationActivity/contracts/index.js";
import type { VoiceRecordingAvailabilityPort } from "../../../modules/voiceChannel/public.js";
import { badRequest } from "../../../shared/domain/errors.js";

import { isMachinePrincipal, type MachineAwareRoutePrincipal } from "../shared/machinePublicSurfacePolicy.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { holdsWorkspacePermission, requireWorkspacePermission } from "../middleware/requirePermission.js";
import { includeDebugQuerySchema, presentDocumentSearchResponse } from "../presenters/documentSearchPresenter.js";
import {
  chatHistoryPageQuerySchema,
  collectionPageQuerySchema,
  conversationParamsSchema,
  operatorConversationTailQuerySchema,
  historyContactParamsSchema,
  conversationWindowQuerySchema,
  historySearchParamsSchema,
  historyItemsPageQuerySchema,
  historyItemsListQuerySchema,
  visitorConversationsParamsSchema,
  visitorConversationsQuerySchema,
} from "./conversationRouteSchemas.js";

type HistoryRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  "assistantHistoryService" | "documentSearchHistoryService" | "conversationErasure"
> & { voiceRecordings: VoiceRecordingAvailabilityPort };

/**
 * A voice conversation's detail tells a dashboard session whether the call has a recording it can
 * play, from what Radioso stores alone: no vendor call. Machine credentials cannot play one, so
 * their detail leaves it out, as does a conversation that is not a call or whose records cannot be
 * read now.
 */
const withRecordingAvailability = async <Detail extends { conversationId: string; sourceChannel: string | null }>(
  dependencies: Pick<HistoryRouteDependencies, "voiceRecordings">,
  res: Response,
  workspaceId: string,
  conversation: Detail,
): Promise<Detail & { recording?: { available: boolean } }> => {
  const { authPrincipal } = res.locals as { authPrincipal?: MachineAwareRoutePrincipal };
  if (isMachinePrincipal(authPrincipal)) return conversation;
  const available = await dependencies.voiceRecordings.availability({
    workspaceId,
    conversationId: conversation.conversationId,
    sourceChannel: conversation.sourceChannel,
  });
  return available === null ? conversation : { ...conversation, recording: { available } };
};

/**
 * Who asked for an erasure: the signed-in teammate, or a personal credential's owner. A service
 * account has no person behind it; its credential joins the audit event from the request's own audit
 * context.
 */
export const erasureActor = (res: Response): ConversationErasureActor => {
  const { accountId, userId, authPrincipal } = res.locals as {
    accountId: string;
    userId?: string;
    authPrincipal?: { type: string; userId?: unknown };
  };
  if (userId) return { accountId, userId };
  if (authPrincipal?.type === "personal_api_credential" && typeof authPrincipal.userId === "string") {
    return { accountId, userId: authPrincipal.userId };
  }
  return { accountId, userId: null };
};

export const createHistoryRoutes = (dependencies: HistoryRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const historyRead = requireWorkspacePermission(dependencies, "workspace.history.read");
  const historyDelete = requireWorkspacePermission(dependencies, "workspace.history.delete");
  // A conversation's activity carries feedback triage outcomes only to a caller who may read them.
  const activityScope = (res: Response): Promise<ConversationActivityReadScope> =>
    resolveActivityReadScope((permission) => holdsWorkspacePermission(dependencies, res, permission));

  router.get("/", workspaceSession, historyRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedQuery = historyItemsListQuerySchema.safeParse(req.query);
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
      const parsedQuery = chatHistoryPageQuerySchema.safeParse(req.query);
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
        await activityScope(res),
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
      const parsedQuery = includeDebugQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const search = await dependencies.documentSearchHistoryService.getHistory(workspaceId, parsedParams.data.searchId);
      res.status(200).json(presentDocumentSearchResponse(search, parsedQuery.data.includeDebug));
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
        await activityScope(res),
      );
      res.status(200).json(await withRecordingAvailability(dependencies, res, workspaceId, conversation));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/chat/:conversationId", workspaceSession, historyDelete, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedParams = conversationParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      await dependencies.conversationErasure.eraseConversation({
        workspaceId,
        conversationId: parsedParams.data.conversationId,
        actor: erasureActor(res),
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/chat/:conversationId/tail", workspaceSession, historyRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedParams = conversationParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const parsedQuery = operatorConversationTailQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const tail = await dependencies.assistantHistoryService.tailConversation(
        workspaceId,
        parsedParams.data.conversationId,
        parsedQuery.data,
        await activityScope(res),
      );
      res.status(200).json(tail);
    } catch (error) {
      next(error);
    }
  });

  router.get("/visitors/:visitorId/conversations", workspaceSession, historyRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedParams = visitorConversationsParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const parsedQuery = visitorConversationsQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const page = await dependencies.assistantHistoryService.listVisitorConversations(
        workspaceId,
        parsedParams.data.visitorId,
        parsedQuery.data,
      );
      res.status(200).json(page);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/visitors/:visitorId", workspaceSession, historyDelete, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedParams = visitorConversationsParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      await dependencies.conversationErasure.eraseVisitor({
        workspaceId,
        visitorId: parsedParams.data.visitorId,
        actor: erasureActor(res),
      });
      res.status(204).end();
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
        await activityScope(res),
      );
      res.status(200).json(await withRecordingAvailability(dependencies, res, workspaceId, conversation));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
