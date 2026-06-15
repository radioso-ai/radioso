import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import {
  emailSkillActivityQuerySchema,
  presentEmailSkillActivity,
} from "../../../modules/customerEmail/public.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";

type EmailSkillActivityRouteDependencies = Pick<
  AppDependencies,
  "env" | "authService" | "accountAccessService" | "workspaceSessionService" | "emailSkillActivityRepository"
>;

const uuidSchema = z.string().uuid();

const parseUuid = (raw: unknown, field: string): string => {
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(`Invalid ${field}`);
  }
  return parsed.data;
};

export const createEmailSkillActivityRoutes = (dependencies: EmailSkillActivityRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const settingsRead = requireWorkspacePermission(dependencies, "workspace.settings.read", (req) =>
    parseUuid(req.params.workspaceId, "workspaceId"),
  );

  router.get("/workspaces/:workspaceId/email-skill-activity", workspaceSession, settingsRead, async (req, res, next) => {
    try {
      const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
      const sessionWorkspaceId = (res.locals as { workspaceId?: string }).workspaceId;
      if (sessionWorkspaceId !== workspaceId) {
        throw badRequest("Workspace route does not match active workspace session");
      }
      const parsedQuery = emailSkillActivityQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        throw badRequest("Invalid activity query", parsedQuery.error.flatten());
      }
      const activities = await dependencies.emailSkillActivityRepository.list({
        workspaceId,
        agentId: parsedQuery.data.agentId,
        connectionId: parsedQuery.data.connectionId,
        skillDefinitionId: parsedQuery.data.skillDefinitionId,
        outcome: parsedQuery.data.outcome,
        createdFrom: parsedQuery.data.createdFrom ? new Date(parsedQuery.data.createdFrom) : undefined,
        createdTo: parsedQuery.data.createdTo ? new Date(parsedQuery.data.createdTo) : undefined,
        limit: parsedQuery.data.limit,
      });
      res.status(200).json({ activities: activities.map(presentEmailSkillActivity) });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
