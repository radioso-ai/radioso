import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { badRequest, serviceUnavailable } from "../../../shared/domain/errors.js";
import { buildSlackManifest, getSlackReadiness, requiredSlackEnvVars } from "../../../modules/slack/public.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";

type SlackConnectionRouteDependencies = Pick<
  AppDependencies,
  "env" | "authService" | "accountAccessService" | "workspaceSessionService" | "oauthConnectionService" | "slackInstallationService" | "agentService"
>;

const uuidSchema = z.string().uuid();
const bindingUpdateSchema = z.object({
  answeringAgentId: z.string().uuid(),
  escalationChannelId: z.string().trim().min(1).nullable().optional(),
});

const parseUuid = (raw: unknown, field: string): string => {
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(`Invalid ${field}`);
  }
  return parsed.data;
};

const presentBinding = (binding: Awaited<ReturnType<AppDependencies["slackInstallationService"]["getBinding"]>>) => ({
  answeringAgentId: binding?.answeringAgentId ?? null,
  escalationChannelId: binding?.escalationChannelId ?? null,
});

export const createSlackConnectionRoutes = (dependencies: SlackConnectionRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const agentsRead = requireWorkspacePermission(dependencies, "workspace.agents.read", (req) =>
    parseUuid(req.params.workspaceId, "workspaceId"),
  );
  const agentsManage = requireWorkspacePermission(dependencies, "workspace.agents.manage", (req) =>
    parseUuid(req.params.workspaceId, "workspaceId"),
  );
  const slackReadiness = () => getSlackReadiness(dependencies.env);

  router.post(
    "/workspaces/:workspaceId/slack/install/start",
    workspaceSession,
    agentsManage,
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        const readiness = slackReadiness();
        if (!readiness.configured) {
          throw serviceUnavailable(
            `Slack install requires ${readiness.missingEnvVars.join(", ")}`,
          );
        }
        const started = await dependencies.oauthConnectionService.create(workspaceId, {
          provider: "slack",
          displayName: "Slack",
        });
        res.status(200).json({
          authorizationUrl: started.authorizationUrl,
          connectionId: started.connectionId,
          status: started.status,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/workspaces/:workspaceId/slack/install/status",
    workspaceSession,
    agentsRead,
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        res.status(200).json({
          ...(await dependencies.slackInstallationService.getStatus(workspaceId)),
          readiness: slackReadiness(),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/workspaces/:workspaceId/slack/manifest",
    workspaceSession,
    agentsRead,
    async (req, res, next) => {
      try {
        parseUuid(req.params.workspaceId, "workspaceId");
        if (!dependencies.env.APP_BASE_URL) {
          throw serviceUnavailable("APP_BASE_URL must be set to generate a Slack app manifest");
        }
        res.status(200).json({
          manifest: buildSlackManifest(dependencies.env.APP_BASE_URL),
          requiredEnvVars: [...requiredSlackEnvVars],
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/workspaces/:workspaceId/slack/binding",
    workspaceSession,
    agentsRead,
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        res.status(200).json(presentBinding(await dependencies.slackInstallationService.getBinding(workspaceId)));
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/workspaces/:workspaceId/slack/binding",
    workspaceSession,
    agentsManage,
    validateBody(bindingUpdateSchema),
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        await dependencies.agentService.get(workspaceId, req.body.answeringAgentId);
        const binding = await dependencies.slackInstallationService.setBinding({
          workspaceId,
          answeringAgentId: req.body.answeringAgentId,
          escalationChannelId: req.body.escalationChannelId ?? null,
        });
        res.status(200).json(presentBinding(binding));
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    "/workspaces/:workspaceId/slack/installation",
    workspaceSession,
    agentsManage,
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        await dependencies.slackInstallationService.disconnect(workspaceId);
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
