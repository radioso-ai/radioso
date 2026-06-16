import { Router, type Request, type Response } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import {
  webhookSkillDefinitionCreateSchema,
  webhookSkillDefinitionUpdateSchema,
} from "../../../modules/webhookSkills/public.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";

type WebhookSkillRouteDependencies = Pick<
  AppDependencies,
  "env" | "authService" | "accountAccessService" | "workspaceSessionService" | "agentService" | "webhookSkillDefinitionService"
>;

const uuidSchema = z.string().uuid();

const parseUuid = (raw: unknown, field: string): string => {
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(`Invalid ${field}`);
  }
  return parsed.data;
};

export const createWebhookSkillRoutes = (dependencies: WebhookSkillRouteDependencies): Router => {
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

  router.get("/:agentId/webhook-skills", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId, agentId } = await resolveAgent(req, res);
      const skills = await dependencies.webhookSkillDefinitionService.list(workspaceId, agentId);
      res.status(200).json({ skills });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:agentId/webhook-skills",
    workspaceSession,
    agentManage,
    validateBody(webhookSkillDefinitionCreateSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, agentId } = await resolveAgent(req, res);
        const skill = await dependencies.webhookSkillDefinitionService.create(workspaceId, agentId, req.body);
        res.status(201).json({ skill });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/:agentId/webhook-skills/:skillId", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId, agentId } = await resolveAgent(req, res);
      const skill = await dependencies.webhookSkillDefinitionService.get(
        workspaceId,
        agentId,
        parseUuid(req.params.skillId, "skillId"),
      );
      res.status(200).json({ skill });
    } catch (error) {
      next(error);
    }
  });

  router.patch(
    "/:agentId/webhook-skills/:skillId",
    workspaceSession,
    agentManage,
    validateBody(webhookSkillDefinitionUpdateSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, agentId } = await resolveAgent(req, res);
        const skill = await dependencies.webhookSkillDefinitionService.update(
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

  router.delete("/:agentId/webhook-skills/:skillId", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId, agentId } = await resolveAgent(req, res);
      await dependencies.webhookSkillDefinitionService.remove(
        workspaceId,
        agentId,
        parseUuid(req.params.skillId, "skillId"),
      );
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
