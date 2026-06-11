import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import {
  webhookDestinationCreateSchema,
  webhookDestinationUpdateSchema,
} from "../../../modules/webhooks/public.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { webhookDestinationIdParamSchema } from "./webhookDestinationRouteSchemas.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import {
  requireWorkspaceSession,
  type WorkspaceSessionDependencies,
} from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import {
  presentWebhookDestination,
  presentWebhookDestinationWithSecret,
} from "../presenters/webhookDestinationPresenter.js";

type SettingsWebhookDestinationDependencies = WorkspaceSessionDependencies &
  Pick<AppDependencies, "accountAccessService" | "webhookDestinations">;

const parseDestinationId = (raw: unknown): string => {
  const parsed = webhookDestinationIdParamSchema.shape.id.safeParse(raw);
  if (!parsed.success) {
    throw badRequest("Invalid webhook destination id");
  }
  return parsed.data;
};

export const createSettingsWebhookDestinationRoutes = (
  dependencies: SettingsWebhookDestinationDependencies,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const settingsRead = requireWorkspacePermission(dependencies, "workspace.settings.read");
  const settingsManage = requireWorkspacePermission(dependencies, "workspace.settings.manage");

  router.get("/", workspaceSession, settingsRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const destinations = await dependencies.webhookDestinations.list(workspaceId);
      res.status(200).json({ destinations: destinations.map(presentWebhookDestination) });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/",
    workspaceSession,
    settingsManage,
    validateBody(webhookDestinationCreateSchema),
    async (req, res, next) => {
      try {
        const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
        const created = await dependencies.webhookDestinations.create({
          workspaceId,
          name: req.body.name,
          url: req.body.url,
          actor: { accountId },
        });
        res.status(201).json(presentWebhookDestinationWithSecret(created));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/:id", workspaceSession, settingsRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const destination = await dependencies.webhookDestinations.get(
        workspaceId,
        parseDestinationId(req.params.id),
      );
      res.status(200).json({ destination: presentWebhookDestination(destination) });
    } catch (error) {
      next(error);
    }
  });

  router.put(
    "/:id",
    workspaceSession,
    settingsManage,
    validateBody(webhookDestinationUpdateSchema),
    async (req, res, next) => {
      try {
        const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
        const destination = await dependencies.webhookDestinations.update({
          workspaceId,
          id: parseDestinationId(req.params.id),
          name: req.body.name,
          url: req.body.url,
          actor: { accountId },
        });
        res.status(200).json({ destination: presentWebhookDestination(destination) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post("/:id/rotate-secret", workspaceSession, settingsManage, async (req, res, next) => {
    try {
      const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
      const rotated = await dependencies.webhookDestinations.rotateSecret(
        workspaceId,
        parseDestinationId(req.params.id),
        { accountId },
      );
      res.status(200).json(presentWebhookDestinationWithSecret(rotated));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", workspaceSession, settingsManage, async (req, res, next) => {
    try {
      const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
      await dependencies.webhookDestinations.delete(
        workspaceId,
        parseDestinationId(req.params.id),
        { accountId },
      );
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
