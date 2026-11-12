import { Router } from "express";
import { z } from "zod";

import type { VisitorImageService } from "../../../modules/visitorImages/public.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { acceptWorkspaceIdFromQuery } from "../middleware/acceptWorkspaceIdFromQuery.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { refuseHeadForAuditedMedia, requireDashboardFetch } from "../shared/dashboardMediaGuards.js";
import { sendVisitorImage } from "../shared/visitorImageUpload.js";

type ConversationImageRouteDependencies = WorkspaceSessionDependencies & {
  visitorImages: Pick<VisitorImageService, "readInConversation">;
};

const conversationImageParamsSchema = z.object({
  conversationId: z.string().uuid(),
  imageId: z.string().uuid(),
});

/**
 * `GET /api/v1/conversations/:conversationId/images/:imageId`: a photo a visitor sent in the
 * conversation, for a teammate who may read the workspace's conversations, in a dashboard session
 * (`apiPrincipalRoutePolicy` refuses machine credentials), from the dashboard's own pages. The
 * Inbox shows it in an `<img>` element, which cannot carry the workspace header, so the workspace
 * may come as a `workspaceId` query selector. Every view that sends the photo is audited
 * (`conversation.image_viewed`).
 */
export const createConversationImageRoutes = (dependencies: ConversationImageRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const historyRead = requireWorkspacePermission(dependencies, "workspace.history.read");

  router.get(
    "/:conversationId/images/:imageId",
    refuseHeadForAuditedMedia("view an image"),
    requireDashboardFetch("An image opens only from the dashboard."),
    acceptWorkspaceIdFromQuery,
    workspaceSession,
    historyRead,
    async (req, res, next) => {
      try {
        const params = conversationImageParamsSchema.safeParse(req.params);
        if (!params.success) {
          next(badRequest("Invalid request params", params.error.flatten()));
          return;
        }
        const { workspaceId, userId } = res.locals as { workspaceId: string; userId?: string };
        const bytes = await dependencies.visitorImages.readInConversation({
          workspaceId,
          conversationId: params.data.conversationId,
          imageId: params.data.imageId,
          actorUserId: userId ?? null,
        });
        if (!bytes) {
          next(notFound("Image not found"));
          return;
        }
        sendVisitorImage(res, bytes);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
