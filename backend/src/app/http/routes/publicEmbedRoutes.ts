import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { isAllowedWebsiteEmbedOrigin } from "../../../modules/settings/domain/websiteEmbedSettings.js";
import {
  isAssistantBootstrapActive,
  resolveAssistantDisplayName,
} from "../../../modules/settings/domain/assistantBootstrapSettings.js";
import { issueWebsiteEmbedSession } from "../../../modules/settings/domain/websiteEmbedSession.js";
import { serviceUnavailable } from "../../../shared/domain/errors.js";

export const createPublicEmbedRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const embedBootstrapBodySchema = z.object({
    anonymousSessionId: z.string().uuid().optional(),
  });
  const corsHeaders = {
    "Access-Control-Allow-Methods": "OPTIONS, POST",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  } as const;

  const resolveOrigin = (value: string | undefined) => {
    if (!value) {
      return null;
    }

    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };

  const applyCorsHeaders = (response: { setHeader(name: string, value: string): unknown }, origin: string | null) => {
    Object.entries(corsHeaders).forEach(([name, value]) => response.setHeader(name, value));
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
    }
  };

  router.options("/:token/session", async (req, res, next) => {
    try {
      const origin = resolveOrigin(req.header("origin"));
      if (!origin) {
        applyCorsHeaders(res, null);
        res.status(400).json({
          error: {
            code: "bad_request",
            message: "Invalid embed session request",
          },
        });
        return;
      }

      const workspace = await dependencies.workspaceRepository.findByWebsiteEmbedToken(req.params.token);
      if (!workspace || !workspace.websiteEmbedEnabled || !workspace.anonymousChatToken) {
        applyCorsHeaders(res, null);
        res.status(404).json({
          error: {
            code: "not_found",
            message: "Embedded chat not found",
          },
        });
        return;
      }

      if (!isAllowedWebsiteEmbedOrigin(workspace.websiteEmbedAllowedOrigins, origin)) {
        applyCorsHeaders(res, null);
        res.status(403).json({
          error: {
            code: "forbidden",
            message: "This website is not approved to host the embedded assistant.",
          },
        });
        return;
      }

      applyCorsHeaders(res, origin);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/:token/session", async (req, res, next) => {
    try {
      const origin = resolveOrigin(req.header("origin"));
      if (!origin) {
        applyCorsHeaders(res, null);
        res.status(400).json({
          error: {
            code: "bad_request",
            message: "Invalid embed session request",
          },
        });
        return;
      }

      const workspace = await dependencies.workspaceRepository.findByWebsiteEmbedToken(req.params.token);
      if (!workspace) {
        applyCorsHeaders(res, null);
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

        applyCorsHeaders(res, null);
        res.status(403).json({
          error: {
            code: "forbidden",
            message: "This website is not approved to host the embedded assistant.",
          },
        });
        return;
      }

      applyCorsHeaders(res, origin);

      const embedSecret = dependencies.env.WEBSITE_EMBED_SECRET;
      if (!embedSecret) {
        throw serviceUnavailable("Website embed sessions are not configured.", {
          missingEnv: "WEBSITE_EMBED_SECRET",
        });
      }
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

      await dependencies.auditService.record({
        accountId: workspace.accountId,
        workspaceId: workspace.id,
        eventType: "website_embed.launch_allowed",
        eventStatus: "success",
        metadata: { origin },
      });

      const embedSession = issueWebsiteEmbedSession(embedSecret, {
        workspaceId: workspace.id,
        publicChatToken: workspace.anonymousChatToken,
        anonymousSessionId: parsedBody.data.anonymousSessionId ?? randomUUID(),
        sourceOrigin: origin,
      });

      res.status(200).json({
        workspaceName: resolveAssistantDisplayName({
          assistantName: workspace.assistantName,
          workspaceName: workspace.name,
        }),
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
