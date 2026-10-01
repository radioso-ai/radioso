import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { resolveActivityReadScope } from "../../../modules/conversationActivity/contracts/index.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { holdsWorkspacePermission, requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";

type ConversationActivityRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "conversationActivityReads">;

const recentlyClosedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
}).strict();

export const createConversationActivityRoutes = (
  dependencies: ConversationActivityRouteDependencies,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  // The Inbox reads this strip, and the Inbox is the takeover surface.
  const takeoverPermission = requireWorkspacePermission(dependencies, "workspace.conversation.takeover");

  // The Inbox's recently closed items: handoffs handed back, approvals decided, negative feedback
  // resolved or dismissed — newest first, each with the teammate who closed it. Feedback is a
  // Quality triage outcome, so it is listed only to a caller who may read Quality.
  router.get("/recently-closed", workspaceSession, takeoverPermission, async (req, res, next) => {
    try {
      const query = recentlyClosedQuerySchema.safeParse(req.query);
      if (!query.success) {
        throw badRequest("Invalid query", query.error.flatten());
      }
      const { workspaceId } = res.locals as { workspaceId: string };
      const scope = await resolveActivityReadScope((permission) => holdsWorkspacePermission(dependencies, res, permission));
      const items = await dependencies.conversationActivityReads.listRecentlyClosed(workspaceId, query.data.limit, scope);

      res.status(200).json({ items });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
