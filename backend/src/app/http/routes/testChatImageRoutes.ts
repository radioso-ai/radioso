import { Router } from "express";
import { z } from "zod";

import type { AuthenticatedPrincipal } from "../../../modules/account/services/accountAccessService.js";
import type { TestExecutionService } from "../../../modules/test-execution/public.js";
import type { VisitorImageService } from "../../../modules/visitorImages/public.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { acceptWorkspaceIdFromQuery } from "../middleware/acceptWorkspaceIdFromQuery.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { refuseHeadForAuditedMedia, requireDashboardFetch } from "../shared/dashboardMediaGuards.js";
import { authenticatedVisitorImageOwner, sendVisitorImage } from "../shared/visitorImageUpload.js";

type TestChatImageRouteDependencies = WorkspaceSessionDependencies & {
  testExecutionService: Pick<TestExecutionService, "namesImage">;
  visitorImages: Pick<VisitorImageService, "readForTestChat">;
};

const testChatImageParamsSchema = z.object({
  agentId: z.string().uuid(),
  executionId: z.string().uuid(),
  imageId: z.string().uuid(),
});

/**
 * `GET /api/v1/agents/:agentId/test-executions/:executionId/images/:imageId`: a photo in a Test
 * Chat transcript, for a teammate who may manage the agent and read its conversations, in a
 * dashboard session (`apiPrincipalRoutePolicy` refuses machine credentials). A test keeps its
 * transcript apart from conversations, so the conversation image route never finds its photos.
 * It serves a photo bound to the test, one its transcript names (from the comparison it continues
 * or the conversation it started from), or one the caller uploaded, which their own message shows
 * before its turn is stored; each check reads only what it needs. Test Chat shows it in an `<img>`
 * element, which cannot carry the workspace header, so the workspace may come as a `workspaceId`
 * query selector. Every view is audited.
 */
export const createTestChatImageRoutes = (dependencies: TestChatImageRouteDependencies): Router => {
  const router = Router();

  router.get(
    "/:agentId/test-executions/:executionId/images/:imageId",
    refuseHeadForAuditedMedia("view an image"),
    requireDashboardFetch("An image opens only from the dashboard."),
    acceptWorkspaceIdFromQuery,
    requireWorkspaceSession(dependencies),
    requireWorkspacePermission(dependencies, "workspace.agents.manage"),
    requireWorkspacePermission(dependencies, "workspace.history.read"),
    async (req, res, next) => {
      try {
        const params = testChatImageParamsSchema.safeParse(req.params);
        if (!params.success) {
          next(badRequest("Invalid request params", params.error.flatten()));
          return;
        }
        const { agentId, executionId, imageId } = params.data;
        const { workspaceId, userId, authPrincipal } = res.locals as { workspaceId: string; userId?: string; authPrincipal?: AuthenticatedPrincipal };
        const bytes = await dependencies.visitorImages.readForTestChat({
          workspaceId,
          agentId,
          testExecutionId: executionId,
          imageId,
          caller: authenticatedVisitorImageOwner(authPrincipal),
          actorUserId: userId ?? null,
          transcriptNamesImage: () => dependencies.testExecutionService.namesImage({ workspaceId, agentId, executionId, imageId }),
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
