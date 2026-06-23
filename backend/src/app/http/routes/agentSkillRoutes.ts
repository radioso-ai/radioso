import { Router, type Request, type Response } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { agentSkillCreateSchema, agentSkillUpdateSchema } from "../../../modules/agentSkills/public.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";

type AgentSkillRouteDependencies = Pick<
  AppDependencies,
  | "env"
  | "authService"
  | "accountAccessService"
  | "workspaceSessionService"
  | "logger"
  | "agentService"
  | "agentSkillsService"
  | "skillCapabilityRegistry"
>;

const uuidSchema = z.string().uuid();

const parseUuid = (raw: unknown, field: string): string => {
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(`Invalid ${field}`);
  }
  return parsed.data;
};

export const createAgentSkillRoutes = (dependencies: AgentSkillRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const agentRead = requireWorkspacePermission(dependencies, "workspace.agents.read");
  const agentManage = requireWorkspacePermission(dependencies, "workspace.agents.manage");

  const resolveAgent = async (req: Request, res: Response): Promise<{ workspaceId: string; agentId: string }> => {
    const { workspaceId } = res.locals as { workspaceId: string };
    const agentId = parseUuid(req.params.agentId, "agentId");
    await dependencies.agentService.get(workspaceId, agentId);
    return { workspaceId, agentId };
  };

  router.get("/:agentId/skill-capabilities", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId, agentId } = await resolveAgent(req, res);
      const capabilities = await Promise.all(dependencies.skillCapabilityRegistry.list().map(async (descriptor) => {
        const targets = await descriptor.enumerateTargets({ workspaceId, agentId });
        const requiresTarget = descriptor.requiresTarget ?? true;
        const available = requiresTarget ? targets.length > 0 : true;
        return {
          id: descriptor.id,
          storedKind: descriptor.storedKind,
          targetKind: descriptor.targetKind,
          requiresTarget,
          inputSchema: descriptor.inputSchema,
          settingsFields: descriptor.settingsFields,
          outcomeVocabulary: descriptor.outcomeVocabulary,
          supportedInvocationModes: descriptor.supportedInvocationModes,
          defaultInvocationMode: descriptor.defaultInvocationMode ?? descriptor.supportedInvocationModes[0],
          executorAdapter: descriptor.executorAdapter,
          targets,
          available,
          unavailableReason: available ? null : "no_connection",
        };
      }));
      dependencies.logger.info({
        event: "agent_skill_capabilities_resolved",
        workspaceId,
        agentId,
        capabilityCount: capabilities.length,
        availableCount: capabilities.filter((capability) => capability.available).length,
      });
      res.status(200).json({ capabilities });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:agentId/skills", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId, agentId } = await resolveAgent(req, res);
      const skills = await dependencies.agentSkillsService.list(workspaceId, agentId);
      res.status(200).json({ skills });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:agentId/skills",
    workspaceSession,
    agentManage,
    validateBody(agentSkillCreateSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, agentId } = await resolveAgent(req, res);
        const skill = await dependencies.agentSkillsService.create(workspaceId, agentId, req.body);
        res.status(201).json({ skill });
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    "/:agentId/skills/:skillId",
    workspaceSession,
    agentManage,
    validateBody(agentSkillUpdateSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, agentId } = await resolveAgent(req, res);
        const skill = await dependencies.agentSkillsService.update(
          workspaceId,
          agentId,
          parseUuid(req.params.skillId, "skillId"),
          req.body,
        );
        res.status(200).json({ skill });
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete("/:agentId/skills/:skillId", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId, agentId } = await resolveAgent(req, res);
      await dependencies.agentSkillsService.remove(workspaceId, agentId, parseUuid(req.params.skillId, "skillId"));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
