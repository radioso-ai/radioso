import type { Router } from "express";
import type { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import {
  requireRestAgentChannelCredential,
  type AgentChannelCredentialLocals,
} from "../middleware/requireAgentChannelCredential.js";
import { createAgentChannelSourceRateLimiter, type AgentChannelRateLimiterDependencies } from "../middleware/agentChannelRateLimiter.js";
import { apiVisitorImageUploadRateLimiter } from "../middleware/visitorImageUploadRateLimiter.js";
import {
  agentChannelVisitorImageOwner,
  countingRateLimitRefusals,
  presentVisitorImageUpload,
  requireVisitorImagesAvailable,
  visitorImageMultipart,
  visitorImageUploadRejection,
  type visitorImageUploadFieldsSchema,
} from "../shared/visitorImageUpload.js";

type AgentChannelImageRouteDependencies = AgentChannelRateLimiterDependencies
  & Pick<AppDependencies, "accessGrantService" | "agentRepository" | "visitorImages" | "visitorImageAvailability" | "metricsRegistry">;

/**
 * `POST /:agentId/images` — an image for the REST agent channel's next message. The REST
 * credential bound to the agent uploads it, and only that credential can send it in
 * `POST /:agentId/chat`. The source budget, the credential, the agent's image check and the
 * upload budgets all run before multer buffers the body.
 */
export const registerAgentChannelImageRoute = (
  router: Router,
  dependencies: AgentChannelImageRouteDependencies,
): void => {
  const metrics = dependencies.metricsRegistry ?? null;

  router.post(
    "/:agentId/images",
    createAgentChannelSourceRateLimiter(dependencies),
    requireRestAgentChannelCredential(dependencies),
    requireVisitorImagesAvailable({
      availability: dependencies.visitorImageAvailability,
      metrics,
      agentOf: (_req, res) => {
        const { agentChannelGrant } = res.locals as Partial<AgentChannelCredentialLocals>;
        return agentChannelGrant ? { workspaceId: agentChannelGrant.workspaceId, agentId: agentChannelGrant.agentId } : null;
      },
    }),
    ...countingRateLimitRefusals([apiVisitorImageUploadRateLimiter(dependencies)], metrics),
    visitorImageMultipart(metrics),
    async (req, res, next) => {
      try {
        const { agentChannelGrant } = res.locals as AgentChannelCredentialLocals;
        const fields = req.body as z.infer<typeof visitorImageUploadFieldsSchema>;
        const result = await dependencies.visitorImages.upload({
          workspaceId: agentChannelGrant.workspaceId,
          agentId: agentChannelGrant.agentId,
          owner: agentChannelVisitorImageOwner(agentChannelGrant),
          bytes: req.file!.buffer,
          locale: fields.locale ?? null,
          surface: "agent_api",
        });
        if (result.kind === "rejected") throw visitorImageUploadRejection(result.reason);
        res.status(201).json(presentVisitorImageUpload(result));
      } catch (error) {
        next(error);
      }
    },
  );
};
