import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import {
  apiConnectionCreateSchema,
  apiConnectionIdSchema,
  apiConnectionUpdateSchema,
  apiRequestTestSchema,
} from "../../../modules/apiRequestSkills/public.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import {
  requireWorkspaceSession,
  type WorkspaceSessionDependencies,
} from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { presentApiConnection } from "../presenters/apiConnectionPresenter.js";

type SettingsApiConnectionDependencies = WorkspaceSessionDependencies &
  Pick<AppDependencies, "accountAccessService" | "apiConnections">;

const parseConnectionId = (raw: unknown): string => {
  const parsed = apiConnectionIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest("Invalid API connection id");
  }
  return parsed.data;
};

/**
 * Workspace API connections: the REST APIs an agent's API request skills call. Reads take
 * settings.read; writes and the test request take settings.manage, since a test request sends a
 * real request with the stored credential.
 */
export const createSettingsApiConnectionRoutes = (
  dependencies: SettingsApiConnectionDependencies,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const settingsRead = requireWorkspacePermission(dependencies, "workspace.settings.read");
  const settingsManage = requireWorkspacePermission(dependencies, "workspace.settings.manage");

  router.get("/", workspaceSession, settingsRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const connections = await dependencies.apiConnections.list(workspaceId);
      res.status(200).json({ connections: connections.map(presentApiConnection) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", workspaceSession, settingsManage, validateBody(apiConnectionCreateSchema), async (req, res, next) => {
    try {
      const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
      const connection = await dependencies.apiConnections.create({ workspaceId, body: req.body, actor: { accountId } });
      res.status(201).json({ connection: presentApiConnection(connection) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:connectionId", workspaceSession, settingsRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const connection = await dependencies.apiConnections.get(workspaceId, parseConnectionId(req.params.connectionId));
      res.status(200).json({ connection: presentApiConnection(connection) });
    } catch (error) {
      next(error);
    }
  });

  router.patch(
    "/:connectionId",
    workspaceSession,
    settingsManage,
    validateBody(apiConnectionUpdateSchema),
    async (req, res, next) => {
      try {
        const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
        const connection = await dependencies.apiConnections.update({
          workspaceId,
          id: parseConnectionId(req.params.connectionId),
          body: req.body,
          actor: { accountId },
        });
        res.status(200).json({ connection: presentApiConnection(connection) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete("/:connectionId", workspaceSession, settingsManage, async (req, res, next) => {
    try {
      const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
      await dependencies.apiConnections.delete(workspaceId, parseConnectionId(req.params.connectionId), { accountId });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:connectionId/test-request",
    workspaceSession,
    settingsManage,
    validateBody(apiRequestTestSchema),
    async (req, res, next) => {
      try {
        const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
        const result = await dependencies.apiConnections.testRequest({
          workspaceId,
          connectionId: parseConnectionId(req.params.connectionId),
          request: req.body,
          actor: { accountId },
        });
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
