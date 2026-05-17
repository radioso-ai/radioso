import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { skillParamsSchema } from "../../../modules/skills/public.js";

type SkillRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "skillCatalogService">;

export const createSkillRoutes = (dependencies: SkillRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const skillRead = requireWorkspacePermission(dependencies, "workspace.skills.read");

  router.get("/", workspaceSession, skillRead, async (_req, res, next) => {
    try {
      const { workspaceId, accountId, userId } = res.locals as {
        workspaceId: string;
        accountId?: string;
        userId?: string;
      };
      const catalog = await dependencies.skillCatalogService.list({ workspaceId, accountId, userId });
      res.status(200).json(catalog);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:skillName", workspaceSession, skillRead, async (req, res, next) => {
    try {
      const parsedParams = skillParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        res.status(404).json({
          error: {
            code: "skill_not_found",
            message: "Skill not found",
          },
        });
        return;
      }

      const { workspaceId, accountId, userId } = res.locals as {
        workspaceId: string;
        accountId?: string;
        userId?: string;
      };
      const skill = await dependencies.skillCatalogService.get(parsedParams.data.skillName, {
        workspaceId,
        accountId,
        userId,
      });
      if (!skill) {
        res.status(404).json({
          error: {
            code: "skill_not_found",
            message: "Skill not found",
          },
        });
        return;
      }

      res.status(200).json(skill);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
