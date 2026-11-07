import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import {
  notificationDeliveryOutcomeSchema,
  type NotificationDeliveryRecord,
} from "../../../modules/operatorNotifications/public.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateQuery } from "../middleware/validate.js";

type NotificationDeliveryRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "notificationDeliveries">;

const DEFAULT_PAGE_SIZE = 50;

export const listNotificationDeliveriesQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  outcome: notificationDeliveryOutcomeSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

/** The wire shape: the address and what happened to it, never a request id or message content. */
export const presentNotificationDelivery = (record: NotificationDeliveryRecord) => ({
  id: record.id,
  agentId: record.agentId,
  conversationId: record.conversationId,
  kind: record.kind,
  recipientEmail: record.recipientEmail,
  outcome: record.outcome,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

/**
 * What happened to each address of each notice, newest first. It names the team's recipient
 * addresses, which are personal data, so it is served to workspace sessions only
 * (apiPrincipalRoutePolicy.ts).
 */
export const createNotificationDeliveryRoutes = (dependencies: NotificationDeliveryRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const agentsRead = requireWorkspacePermission(dependencies, "workspace.agents.read");

  router.get("/", workspaceSession, agentsRead, validateQuery(listNotificationDeliveriesQuerySchema), async (req, res, next) => {
    try {
      const query = req.query as z.infer<typeof listNotificationDeliveriesQuerySchema>;
      const { workspaceId } = res.locals as { workspaceId: string };
      const page = await dependencies.notificationDeliveries.list(workspaceId, {
        agentId: query.agentId,
        outcome: query.outcome,
        cursor: query.cursor,
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
      });
      res.status(200).json({ items: page.items.map(presentNotificationDelivery), nextCursor: page.nextCursor });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
