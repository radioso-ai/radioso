import type { RequestHandler, Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import type { VisitorImageAvailability, VisitorImageService } from "../../../modules/visitorImages/public.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { requirePublicChatPermission } from "../middleware/requirePermission.js";
import { answeredPublicUsageLimit } from "../shared/publicUsageLimit.js";
import {
  publicVisitorImageUploadRateLimiter,
  type VisitorImageUploadRateLimiterDependencies,
} from "../middleware/visitorImageUploadRateLimiter.js";
import {
  countingRateLimitRefusals,
  presentVisitorImageUpload,
  publicVisitorImageOwner,
  requireVisitorImagesAvailable,
  sendVisitorImage,
  visitorImageMultipart,
  visitorImageUploadFieldsSchema,
  visitorImageUploadRejection,
} from "../shared/visitorImageUpload.js";

type PublicVisitorImageRouteDependencies = VisitorImageUploadRateLimiterDependencies
  & Pick<AppDependencies, "accountAccessService" | "metricsRegistry">
  & {
    visitorImages: Pick<VisitorImageService, "upload" | "readForOwner">;
    visitorImageAvailability: VisitorImageAvailability;
  };

const publicVisitorImageParamsSchema = z.object({ imageId: z.string().uuid() });

interface PublicSessionLocals {
  workspaceId: string;
  agentId: string;
  chatSessionId: string;
  sourceChannel: string | null;
}

/**
 * Mounts `POST /:token/images` and `GET /:token/images/:imageId` on the public chat router,
 * behind its public session check, so the website embed and the public link both reach them. An
 * upload runs the session, the `public_chat.turn.create` permission, the three rate budgets and
 * then the agent's photo check (which reads the agent and resolves its model) before multer
 * buffers a byte; it answers once the agent's model has read the photo. A photo is served only to the public session that uploaded it.
 */
export const registerPublicVisitorImageRoutes = (
  router: Router,
  dependencies: PublicVisitorImageRouteDependencies & {
    publicSession: RequestHandler;
    /** The public session's own read budget, which serving a photo spends. */
    sessionReadRateLimit: RequestHandler;
  },
): void => {
  const metrics = dependencies.metricsRegistry ?? null;

  router.post(
    "/:token/images",
    dependencies.publicSession,
    requirePublicChatPermission(dependencies, "public_chat.turn.create"),
    ...countingRateLimitRefusals(publicVisitorImageUploadRateLimiter(dependencies), metrics),
    requireVisitorImagesAvailable({
      availability: dependencies.visitorImageAvailability,
      metrics,
      agentOf: (_req, res) => {
        const { workspaceId, agentId } = res.locals as Partial<PublicSessionLocals>;
        return workspaceId && agentId ? { workspaceId, agentId } : null;
      },
    }),
    visitorImageMultipart(metrics),
    async (req, res, next) => {
      try {
        const { workspaceId, agentId, chatSessionId, sourceChannel } = res.locals as PublicSessionLocals;
        const fields = req.body as z.infer<typeof visitorImageUploadFieldsSchema>;
        const result = await dependencies.visitorImages.upload({
          workspaceId,
          agentId,
          owner: publicVisitorImageOwner(chatSessionId),
          bytes: req.file!.buffer,
          locale: fields.locale ?? null,
          surface: sourceChannel ?? "public_chat",
        });
        if (result.kind === "rejected") {
          next(visitorImageUploadRejection(result.reason));
          return;
        }
        res.setHeader("Cache-Control", "no-store");
        res.status(201).json(presentVisitorImageUpload(result));
      } catch (error) {
        if (answeredPublicUsageLimit(res, error)) return;
        next(error);
      }
    },
  );

  router.get(
    "/:token/images/:imageId",
    dependencies.publicSession,
    requirePublicChatPermission(dependencies, "public_chat.session.read.own"),
    dependencies.sessionReadRateLimit,
    async (req, res, next) => {
      try {
        const params = publicVisitorImageParamsSchema.safeParse(req.params);
        if (!params.success) {
          next(badRequest("Invalid request params", params.error.flatten()));
          return;
        }
        const { workspaceId, chatSessionId } = res.locals as PublicSessionLocals;
        const bytes = await dependencies.visitorImages.readForOwner({
          workspaceId,
          owner: publicVisitorImageOwner(chatSessionId),
          imageId: params.data.imageId,
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
};
