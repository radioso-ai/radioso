import { Router, type Request, type Response } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import {
  slackSkillDefinitionCreateSchema,
  slackSkillDefinitionUpdateSchema,
} from "../../../modules/slackSkills/public.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";

type SlackSkillRouteDependencies = Pick<
  AppDependencies,
  "env" | "authService" | "accountAccessService" | "workspaceSessionService" | "agentService" | "slackSkillDefinitionService"
>;

const uuidSchema = z.string().uuid();

const parseUuid = (raw: unknown, field: string): string => {
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(`Invalid ${field}`);
  }
  return parsed.data;
};

export const createSlackSkillRoutes = (dependencies: SlackSkillRouteDependencies): Router => {
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

  router.get("/:agentId/slack-skills", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId, agentId } = await resolveAgent(req, res);
      const skills = await dependencies.slackSkillDefinitionService.list(workspaceId, agentId);
      res.status(200).json({ skills });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:agentId/slack-skills",
    workspaceSession,
    agentManage,
    validateBody(slackSkillDefinitionCreateSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, agentId } = await resolveAgent(req, res);
        const skill = await dependencies.slackSkillDefinitionService.create(workspaceId, agentId, req.body);
        res.status(201).json({ skill });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/:agentId/slack-skills/:skillId", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId, agentId } = await resolveAgent(req, res);
      const skill = await dependencies.slackSkillDefinitionService.get(
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
    "/:agentId/slack-skills/:skillId",
    workspaceSession,
    agentManage,
    validateBody(slackSkillDefinitionUpdateSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, agentId } = await resolveAgent(req, res);
        const skill = await dependencies.slackSkillDefinitionService.update(
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

  router.delete("/:agentId/slack-skills/:skillId", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId, agentId } = await resolveAgent(req, res);
      await dependencies.slackSkillDefinitionService.remove(
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
