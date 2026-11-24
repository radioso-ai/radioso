import { Router, type Response } from "express";

import type { AppDependencies } from "../../server/types.js";
import type { AttributeEditActor } from "../../../modules/context-variables/public.js";
import { badRequest, unauthorized } from "../../../shared/domain/errors.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { conversationAttributeParamsSchema, conversationAttributeValueBodySchema } from "./conversationRouteSchemas.js";

type HistoryAttributeRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "conversationAttributeEdits">;

// Session-only, like the Inbox's other conversation actions: the teammate signed in is the value's writer.
const inboxActor = (res: Response): AttributeEditActor => {
  const { accountId, userId } = res.locals as { accountId: string; userId?: string };
  if (!userId) throw unauthorized("A signed-in teammate is required");
  return { accountId, userId, surface: "inbox" };
};

const parseParams = (params: unknown) => {
  const parsed = conversationAttributeParamsSchema.safeParse(params);
  if (!parsed.success) throw badRequest("Invalid request params", parsed.error.flatten());
  return parsed.data;
};

/**
 * A teammate sets a conversation's Choice attribute, or resets any it can see, from the Inbox (#1884). Both take
 * the takeover permission rather than the agent-management one the values API needs: answering in
 * the Inbox is what they belong to. Both call the one edit service Ray and operator MCP call.
 */
export const createHistoryAttributeRoutes = (dependencies: HistoryAttributeRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const takeoverPermission = requireWorkspacePermission(dependencies, "workspace.conversation.takeover");

  router.put(
    "/chat/:conversationId/attributes/:name",
    workspaceSession,
    takeoverPermission,
    validateBody(conversationAttributeValueBodySchema),
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const { conversationId, name } = parseParams(req.params);
        const { value } = req.body as { value: string };
        const change = await dependencies.conversationAttributeEdits.set({ workspaceId, conversationId, name, value, actor: inboxActor(res) });
        res.status(200).json(change);
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete("/chat/:conversationId/attributes/:name", workspaceSession, takeoverPermission, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { conversationId, name } = parseParams(req.params);
      const change = await dependencies.conversationAttributeEdits.reset({ workspaceId, conversationId, name, actor: inboxActor(res) });
      res.status(200).json(change);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
