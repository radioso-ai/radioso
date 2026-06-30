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
  // Omitted/null updates the installation default answerer; a value binds a specific Slack channel.
  channelId: z.string().trim().min(1).nullable().optional(),
  answeringAgentId: z.string().uuid(),
  escalationChannelId: z.string().trim().min(1).nullable().optional(),
  gapEscalationEnabled: z.boolean().optional(),
});
const bindingDeleteBodySchema = z.object({
  channelId: z.string().trim().min(1).optional(),
}).passthrough();

const parseUuid = (raw: unknown, field: string): string => {
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(`Invalid ${field}`);
  }
  return parsed.data;
};

const presentBinding = (binding: Awaited<ReturnType<AppDependencies["slackInstallationService"]["getBinding"]>>) => ({
  channelId: binding?.channelId ?? null,
  answeringAgentId: binding?.answeringAgentId ?? null,
  escalationChannelId: binding?.escalationChannelId ?? null,
  gapEscalationEnabled: binding?.gapEscalationEnabled ?? false,
});

const parseChannelId = (req: { query: Record<string, unknown>; body?: unknown }): string => {
  const queryChannelId = req.query.channelId;
  if (typeof queryChannelId === "string" && queryChannelId.trim()) {
    return queryChannelId.trim();
  }
  const body = bindingDeleteBodySchema.safeParse(req.body ?? {});
  if (body.success && body.data.channelId) {
    return body.data.channelId;
  }
  throw badRequest("channelId is required");
};

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
        // Slack reaches the backend directly (OAuth callback + Events API), so
        // the manifest URLs must use the public API origin. On split-host
        // deployments that is CONNECTOR_PUBLIC_BASE_URL; otherwise it falls back
        // to APP_BASE_URL (single-origin / local).
        const apiBaseUrl = dependencies.env.CONNECTOR_PUBLIC_BASE_URL ?? dependencies.env.APP_BASE_URL;
        if (!apiBaseUrl) {
          throw serviceUnavailable("CONNECTOR_PUBLIC_BASE_URL or APP_BASE_URL must be set to generate a Slack app manifest");
        }
        res.status(200).json({
          manifest: buildSlackManifest(apiBaseUrl),
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

  router.get(
    "/workspaces/:workspaceId/slack/bindings",
    workspaceSession,
    agentsRead,
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        const bindings = await dependencies.slackInstallationService.listBindings(workspaceId);
        res.status(200).json({ bindings: bindings.map(presentBinding) });
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
          channelId: req.body.channelId,
          answeringAgentId: req.body.answeringAgentId,
          escalationChannelId: req.body.escalationChannelId,
          gapEscalationEnabled: req.body.gapEscalationEnabled,
        });
        res.status(200).json(presentBinding(binding));
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    "/workspaces/:workspaceId/slack/binding",
    workspaceSession,
    agentsManage,
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        const channelId = parseChannelId(req);
        await dependencies.slackInstallationService.removeChannelBinding(workspaceId, channelId);
        res.status(204).send();
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
