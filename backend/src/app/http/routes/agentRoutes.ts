import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import {
  agentConversationModes,
  agentSurfaceIcons,
  agentSurfacePositions,
} from "../../../modules/agents/public.js";

const agentParamsSchema = z.object({
  agentId: z.string().uuid(),
});

const surfaceSettingsSchema = z.object({
  authenticatedChat: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  anonymousChat: z.object({
    enabled: z.boolean().optional(),
    messagesPerMinute: z.number().int().min(1).max(60).optional(),
  }).optional(),
  websiteEmbed: z.object({
    enabled: z.boolean().optional(),
    allowedOrigins: z.array(z.string().max(200)).max(20).optional(),
    launcherLabel: z.string().max(80).optional(),
    icon: z.enum(agentSurfaceIcons).optional(),
    launcherPosition: z.enum(agentSurfacePositions).optional(),
  }).optional(),
}).optional();

const agentBodySchema = z.object({
  name: z.string().max(200).optional(),
  customInstruction: z.string().max(2000).optional(),
  conversationMode: z.enum(agentConversationModes).optional(),
  suggestedQuestionsEnabled: z.boolean().optional(),
  suggestedQuestionsCount: z.number().int().min(1).max(4).optional(),
  retrievalEnabled: z.boolean().optional(),
  greetingInstruction: z.string().max(200).optional(),
  assistantDefaultLocale: z.string().max(35).nullable().optional(),
  proactiveGreetingEnabled: z.boolean().optional(),
  surfaceSettings: surfaceSettingsSchema,
  rotateAnonymousChatToken: z.boolean().optional(),
  rotateWebsiteEmbedToken: z.boolean().optional(),
});

type AgentRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "agentService">;

export const createAgentRoutes = (dependencies: AgentRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);

  router.get("/", workspaceSession, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      res.status(200).json({ agents: await dependencies.agentService.list(workspaceId) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", workspaceSession, validateBody(agentBodySchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const agent = await dependencies.agentService.create(workspaceId, req.body);
      res.status(201).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:agentId", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const agent = await dependencies.agentService.get(workspaceId, parsed.agentId);
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.put("/:agentId", workspaceSession, validateBody(agentBodySchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const current = await dependencies.agentService.resolve(workspaceId, parsed.agentId);
      const agent = await dependencies.agentService.update(
        workspaceId,
        parsed.agentId,
        dependencies.agentService.withRotatedTokens(current, req.body),
      );
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/default", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const agent = await dependencies.agentService.setDefault(workspaceId, parsed.agentId);
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
