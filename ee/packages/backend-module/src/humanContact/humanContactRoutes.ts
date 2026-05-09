import { Router } from "express";
import { z } from "zod";

import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import { parseBody, requirePublicChatSession, requireWorkspaceSession } from "../shared/chatRouteHelpers.js";
import type { EnterpriseHumanContactService } from "./humanContactService.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

const contactTriggerSourceSchema = z.enum([
  "manual",
  "assistant_suggestion",
  "no_context_refusal",
  "grounded_degraded_unsupported_segments",
  "explicit_user_request",
  "llm_classifier",
]);

const contactDraftSchema = z.object({
  conversationId: z.string().uuid(),
  assistantMessageId: z.string().uuid().optional(),
});

const contactSubmitSchema = z.object({
  conversationId: z.string().uuid(),
  assistantMessageId: z.string().uuid().optional(),
  email: z.string().trim().email().max(320),
  message: z.string().trim().min(1).max(6000),
  triggerSource: contactTriggerSourceSchema,
  triggerReason: z.string().trim().max(500).optional(),
});

const contactSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  emailEnabled: z.boolean().optional(),
  defaultEmail: z.string().trim().email().max(320).nullable().optional(),
  webhookEnabled: z.boolean().optional(),
  webhookUrl: z.string().trim().url().max(2048).nullable().optional(),
  signingSecret: z.string().min(16).max(256).nullable().optional(),
  rotateSigningSecret: z.boolean().optional(),
});

export const createHumanContactRoutes = (
  dependencies: RouteDependencies,
  service: EnterpriseHumanContactService,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const publicChatSession = requirePublicChatSession(dependencies);

  router.get("/settings", workspaceSession, async (_req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      res.status(200).json(await service.getSettings({ workspaceId, accountId }));
    } catch (error) {
      next(error);
    }
  });

  router.put("/settings", workspaceSession, async (req, res, next) => {
    try {
      const body = parseBody(contactSettingsUpdateSchema, req.body);
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      res.status(200).json(await service.updateSettings({ workspaceId, accountId, ...body }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/settings/signing-secret", workspaceSession, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      res.status(200).json(await service.revealSigningSecret({ workspaceId }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/draft", workspaceSession, async (req, res, next) => {
    try {
      const body = parseBody(contactDraftSchema, req.body);
      const { workspaceId, accountId, userId } = res.locals as {
        workspaceId: string;
        accountId: string;
        userId?: string;
      };
      const defaultEmail = userId ? (await dependencies.userRepository.findById(userId))?.email ?? null : null;
      const draft = await service.draft({
        workspaceId,
        accountId,
        conversationId: body.conversationId,
        assistantMessageId: body.assistantMessageId,
        defaultEmail,
        sourceChannel: "authenticated_chat",
      });
      res.status(200).json({ ...draft, defaultEmail });
    } catch (error) {
      next(error);
    }
  });

  router.post("/submit", workspaceSession, async (req, res, next) => {
    try {
      const body = parseBody(contactSubmitSchema, req.body);
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      res.status(202).json(await service.submit({
        workspaceId,
        accountId,
        conversationId: body.conversationId,
        assistantMessageId: body.assistantMessageId,
        email: body.email,
        message: body.message,
        triggerSource: body.triggerSource,
        triggerReason: body.triggerReason,
        sourceChannel: "authenticated_chat",
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/public/chat/:token/draft", publicChatSession, async (req, res, next) => {
    try {
      const body = parseBody(contactDraftSchema, req.body);
      const { workspaceId, agentId, anonymousSessionId, sourceChannel, sourceOrigin } = res.locals as {
        workspaceId: string;
        agentId?: string | null;
        anonymousSessionId: string;
        sourceChannel: string | null;
        sourceOrigin: string | null;
      };
      res.status(200).json(await service.draft({
        workspaceId,
        agentId,
        conversationId: body.conversationId,
        assistantMessageId: body.assistantMessageId,
        anonymousSessionId,
        sourceChannel,
        sourceOrigin,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/public/chat/:token/submit", publicChatSession, async (req, res, next) => {
    try {
      const body = parseBody(contactSubmitSchema, req.body);
      const { workspaceId, agentId, anonymousSessionId, sourceChannel, sourceOrigin } = res.locals as {
        workspaceId: string;
        agentId?: string | null;
        anonymousSessionId: string;
        sourceChannel: string | null;
        sourceOrigin: string | null;
      };
      res.status(202).json(await service.submit({
        workspaceId,
        agentId,
        conversationId: body.conversationId,
        assistantMessageId: body.assistantMessageId,
        anonymousSessionId,
        email: body.email,
        message: body.message,
        triggerSource: body.triggerSource,
        triggerReason: body.triggerReason,
        sourceChannel,
        sourceOrigin,
      }));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
