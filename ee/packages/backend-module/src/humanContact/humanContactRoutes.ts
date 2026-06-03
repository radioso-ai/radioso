import { Router } from "express";
import { z } from "zod";

import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import { parseBody, requireWorkspacePermission, requireWorkspaceSession } from "../shared/chatRouteHelpers.js";
import type { HumanContactSettingsProvider } from "./humanContactContracts.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

const contactSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  emailEnabled: z.boolean().optional(),
  defaultEmail: z.string().trim().email().max(320).nullable().optional(),
  defaultEmails: z.array(z.string().trim().email().max(320)).max(5).nullable().optional(),
  webhookEnabled: z.boolean().optional(),
  webhookUrl: z.string().trim().url().max(2048).nullable().optional(),
  signingSecret: z.string().min(16).max(256).nullable().optional(),
  rotateSigningSecret: z.boolean().optional(),
});

export const createHumanContactRoutes = (
  dependencies: RouteDependencies,
  settingsProvider: HumanContactSettingsProvider,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const settingsRead = requireWorkspacePermission(dependencies, "workspace.settings.read");
  const credentialsManage = requireWorkspacePermission(dependencies, "workspace.credentials.manage");

  const validateWebhookUrl = async (url: string) => {
    if (!dependencies.assertPublicWebsiteUrl) {
      throw {
        statusCode: 500,
        code: "configuration_error",
        message: "Webhook URL validation is unavailable",
      };
    }
    await dependencies.assertPublicWebsiteUrl(url);
  };

  router.get("/settings", workspaceSession, settingsRead, async (_req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      res.status(200).json(await settingsProvider.getSettings({ workspaceId, accountId }));
    } catch (error) {
      next(error);
    }
  });

  router.put("/settings", workspaceSession, credentialsManage, async (req, res, next) => {
    try {
      const body = parseBody(contactSettingsUpdateSchema, req.body);
      if (body.webhookUrl) {
        await validateWebhookUrl(body.webhookUrl);
      }
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      res.status(200).json(await settingsProvider.updateSettings({ workspaceId, accountId, ...body }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/settings/signing-secret", workspaceSession, credentialsManage, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      res.status(200).json(await settingsProvider.revealSigningSecret({ workspaceId }));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
