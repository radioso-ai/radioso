import { Router } from "express";
import { z } from "zod";

import type { AuthenticatedPrincipal } from "../../../modules/account/services/accountAccessService.js";
import type { AppDependencies } from "../../server/types.js";
import { sendChatJson, sendChatSse } from "../presenters/chatPresenter.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { expensiveAuthenticatedRateLimiter } from "../middleware/expensiveAuthenticatedRateLimiter.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { assistantChatSchema } from "../schemas/assistantChatSchemas.js";
import { apiVisitorImageUploadRateLimiter } from "../middleware/visitorImageUploadRateLimiter.js";
import {
  authenticatedVisitorImageOwner,
  countingRateLimitRefusals,
  presentVisitorImageUpload,
  requireVisitorImagesAvailable,
  visitorImageMultipart,
  visitorImageUploadFieldsSchema,
  visitorImageUploadRejection,
} from "../shared/visitorImageUpload.js";

type AssistantRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  "assistantChatService" | "abuseControlService" | "auditService" | "visitorImages" | "visitorImageAvailability" | "metricsRegistry"
>;

const imageUploadQuerySchema = z.object({ agentId: z.string().uuid() });

export const createAssistantRoutes = (dependencies: AssistantRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const rateLimitExpensiveAuthenticatedRequest = expensiveAuthenticatedRateLimiter(dependencies);
  const metrics = dependencies.metricsRegistry ?? null;

  // POST /api/v1/assistant/images?agentId= — upload a photo the agent reads, for a later chat message
  router.post(
    "/images",
    workspaceSession,
    requireWorkspacePermission(dependencies, "workspace.chat.use"),
    validateQuery(imageUploadQuerySchema),
    requireVisitorImagesAvailable({
      availability: dependencies.visitorImageAvailability,
      metrics,
      agentOf: (req, res) => ({ workspaceId: (res.locals as { workspaceId: string }).workspaceId, agentId: imageUploadQuerySchema.parse(req.query).agentId }),
    }),
    ...countingRateLimitRefusals([apiVisitorImageUploadRateLimiter(dependencies)], metrics),
    visitorImageMultipart(metrics),
    async (req, res, next) => {
      try {
        const { workspaceId, authPrincipal } = res.locals as { workspaceId: string; authPrincipal?: AuthenticatedPrincipal };
        const owner = authenticatedVisitorImageOwner(authPrincipal);
        if (!owner) throw badRequest("Images are uploaded by an API credential or a signed-in user");
        const { agentId } = imageUploadQuerySchema.parse(req.query);
        const fields = req.body as z.infer<typeof visitorImageUploadFieldsSchema>;
        const result = await dependencies.visitorImages.upload({
          workspaceId,
          agentId,
          owner,
          bytes: req.file!.buffer,
          locale: fields.locale ?? null,
          surface: "api",
        });
        if (result.kind === "rejected") throw visitorImageUploadRejection(result.reason);
        res.status(201).json(presentVisitorImageUpload(result));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/chat",
    workspaceSession,
    requireWorkspacePermission(dependencies, "workspace.chat.use"),
    validateBody(assistantChatSchema),
    rateLimitExpensiveAuthenticatedRequest,
    async (req, res, next) => {
      try {
        const { workspaceId, accountId, authPrincipal } = res.locals as { workspaceId: string; accountId: string; authPrincipal?: AuthenticatedPrincipal };
        const imageOwner = authenticatedVisitorImageOwner(authPrincipal) ?? undefined;
        if (req.body.stream && req.body.startConversation) {
          throw badRequest("startConversation does not support streaming");
        }
        if (req.body.stream) {
          const disconnectAbort = new AbortController();
          await sendChatSse(
            res,
            dependencies.assistantChatService.streamAnswer({
              workspaceId,
              agentId: req.body.agentId,
              accountId,
              conversationId: req.body.conversationId,
              bootstrapGreetingId: req.body.bootstrapGreetingId,
              message: req.body.message,
              imageIds: req.body.imageIds,
              imageOwner,
              startConversation: req.body.startConversation,
              stream: req.body.stream,
              userExpectedLocale: req.body.userExpectedLocale,
              visitorTimeZone: req.body.userTimeZone,
              inputMetadata: req.body.inputMetadata,
              sourceContext: req.body.sourceContext,
              metadataFilter: req.body.metadataFilter,
              previewRoutineIds: req.body.previewRoutineIds,
              sourceChannel: req.body.sourceContext?.surface ?? null,
              sourceOrigin: req.body.sourceContext?.sourceOrigin ?? null,
              signal: disconnectAbort.signal,
            }),
            {
              includeDebug: req.body.includeDebug,
              onDisconnectCeilingExceeded: () => disconnectAbort.abort(),
            },
          );
          return;
        }

        const response = await dependencies.assistantChatService.answer({
          workspaceId,
          agentId: req.body.agentId,
          accountId,
          conversationId: req.body.conversationId,
          bootstrapGreetingId: req.body.bootstrapGreetingId,
          message: req.body.message,
          imageIds: req.body.imageIds,
          imageOwner,
          startConversation: req.body.startConversation,
          stream: req.body.stream,
          userExpectedLocale: req.body.userExpectedLocale,
          visitorTimeZone: req.body.userTimeZone,
          inputMetadata: req.body.inputMetadata,
          sourceContext: req.body.sourceContext,
          metadataFilter: req.body.metadataFilter,
          previewRoutineIds: req.body.previewRoutineIds,
          sourceChannel: req.body.sourceContext?.surface ?? null,
          sourceOrigin: req.body.sourceContext?.sourceOrigin ?? null,
        });
        if (!response) {
          res.status(204).end();
          return;
        }
        sendChatJson(res, response, { includeDebug: req.body.includeDebug });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
