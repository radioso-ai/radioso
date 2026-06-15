import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { oauthConnectionCreateSchema } from "../../../modules/integrationOauth/public.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";

type OauthConnectionRouteDependencies = Pick<
  AppDependencies,
  "env" | "authService" | "accountAccessService" | "workspaceSessionService" | "oauthConnectionService"
>;

const uuidSchema = z.string().uuid();
const callbackQuerySchema = z.object({
  code: z.string().trim().min(1),
  state: z.string().trim().min(1),
});

const parseUuid = (raw: unknown, field: string): string => {
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(`Invalid ${field}`);
  }
  return parsed.data;
};

const parseCallbackQuery = (query: unknown): { code: string; state: string } => {
  const parsed = callbackQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw badRequest("Invalid OAuth callback query", parsed.error.flatten());
  }
  return parsed.data;
};

export const createOauthConnectionRoutes = (dependencies: OauthConnectionRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const settingsRead = requireWorkspacePermission(dependencies, "workspace.settings.read", (req) =>
    parseUuid(req.params.workspaceId, "workspaceId"),
  );
  const settingsManage = requireWorkspacePermission(dependencies, "workspace.settings.manage", (req) =>
    parseUuid(req.params.workspaceId, "workspaceId"),
  );

  router.post(
    "/workspaces/:workspaceId/oauth-connections",
    workspaceSession,
    settingsManage,
    validateBody(oauthConnectionCreateSchema),
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        res.status(201).json(await dependencies.oauthConnectionService.create(workspaceId, req.body));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/workspaces/:workspaceId/oauth-connections/:connectionId",
    workspaceSession,
    settingsRead,
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        const connectionId = parseUuid(req.params.connectionId, "connectionId");
        const connection = await dependencies.oauthConnectionService.get(workspaceId, connectionId);
        res.status(200).json({ connection });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/workspaces/:workspaceId/oauth-connections/:connectionId/reauthorize",
    workspaceSession,
    settingsManage,
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        const connectionId = parseUuid(req.params.connectionId, "connectionId");
        res.status(200).json(await dependencies.oauthConnectionService.reauthorize(workspaceId, connectionId));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/oauth/callback/:provider", async (req, res, next) => {
    try {
      const provider = z.string().trim().min(1).parse(req.params.provider);
      const completed = await dependencies.oauthConnectionService.completeCallback(
        provider,
        parseCallbackQuery(req.query),
      );
      res.redirect(302, completed.redirectUrl);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
