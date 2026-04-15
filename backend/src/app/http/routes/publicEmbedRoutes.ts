import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { isAllowedWebsiteEmbedOrigin } from "../../../modules/settings/domain/websiteEmbedSettings.js";
import { isAssistantBootstrapActive } from "../../../modules/settings/domain/assistantBootstrapSettings.js";
import { issueWebsiteEmbedSession } from "../../../modules/settings/domain/websiteEmbedSession.js";

export const createPublicEmbedRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const embedBootstrapBodySchema = z.object({
    anonymousSessionId: z.string().uuid().optional(),
  });

  router.post("/:token/session", async (req, res, next) => {
    try {
      const origin = req.header("x-radioso-embed-origin");
      const signature = req.header("x-radioso-embed-signature");

      if (!origin || !signature) {
        res.status(400).json({
          error: {
            code: "bad_request",
            message: "Invalid embed session request",
          },
        });
        return;
      }

      const expectedSignature = createHmac("sha256", dependencies.env.SESSION_COOKIE_SECRET)
        .update(`${req.params.token}:${origin}`)
        .digest("hex");

      const providedSignature = Buffer.from(signature);
      const expectedSignatureBuffer = Buffer.from(expectedSignature);
      if (
        providedSignature.length !== expectedSignatureBuffer.length ||
        !timingSafeEqual(providedSignature, expectedSignatureBuffer)
      ) {
        res.status(403).json({
          error: {
            code: "forbidden",
            message: "This embedded chat launch could not be verified.",
          },
        });
        return;
      }

      const workspace = await dependencies.workspaceRepository.findByWebsiteEmbedToken(req.params.token);
      const parsedBody = embedBootstrapBodySchema.safeParse(req.body ?? {});

      if (!parsedBody.success) {
        res.status(400).json({
          error: {
            code: "bad_request",
            message: "Invalid embed session request",
          },
        });
        return;
      }

      if (!workspace) {
        res.status(404).json({
          error: {
            code: "not_found",
            message: "Embedded chat not found",
          },
        });
        return;
      }

      if (!workspace.websiteEmbedEnabled || !workspace.anonymousChatToken) {
        await dependencies.auditService.record({
          accountId: workspace.accountId,
          workspaceId: workspace.id,
          eventType: "website_embed.launch_denied",
          eventStatus: "failure",
          metadata: {
            origin,
            reason: !workspace.websiteEmbedEnabled ? "embed_disabled" : "missing_public_chat_token",
          },
        });

        res.status(404).json({
          error: {
            code: "not_found",
            message: "Embedded chat not found",
          },
        });
        return;
      }

      if (!isAllowedWebsiteEmbedOrigin(workspace.websiteEmbedAllowedOrigins, origin)) {
        await dependencies.auditService.record({
          accountId: workspace.accountId,
          workspaceId: workspace.id,
          eventType: "website_embed.launch_denied",
          eventStatus: "failure",
          metadata: { origin },
        });

        res.status(403).json({
          error: {
            code: "forbidden",
            message: "This website is not approved to host the embedded assistant.",
          },
        });
        return;
      }

      await dependencies.auditService.record({
        accountId: workspace.accountId,
        workspaceId: workspace.id,
        eventType: "website_embed.launch_allowed",
        eventStatus: "success",
        metadata: { origin },
      });

      const embedSession = issueWebsiteEmbedSession(dependencies.env.SESSION_COOKIE_SECRET, {
        workspaceId: workspace.id,
        publicChatToken: workspace.anonymousChatToken,
        anonymousSessionId: parsedBody.data.anonymousSessionId ?? randomUUID(),
        sourceOrigin: origin,
      });

      res.status(200).json({
        workspaceName: workspace.name,
        publicChatToken: workspace.anonymousChatToken,
        embedSessionToken: embedSession.token,
        assistantBootstrapActive: isAssistantBootstrapActive(workspace),
        expiresAt: embedSession.expiresAt,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
