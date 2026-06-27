import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import {
  customerEmailConnectionCreateSchema,
  customerEmailConnectionUpdateSchema,
} from "../../../modules/customerEmail/public.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";

type CustomerEmailConnectionRouteDependencies = Pick<
  AppDependencies,
  "env" | "authService" | "accountAccessService" | "workspaceSessionService" | "customerEmailConnectionService"
>;

const uuidSchema = z.string().uuid();

const parseUuid = (raw: unknown, field: string): string => {
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(`Invalid ${field}`);
  }
  return parsed.data;
};

export const createCustomerEmailConnectionRoutes = (
  dependencies: CustomerEmailConnectionRouteDependencies,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const settingsRead = requireWorkspacePermission(dependencies, "workspace.settings.read", (req) =>
    parseUuid(req.params.workspaceId, "workspaceId"),
  );
  const settingsManage = requireWorkspacePermission(dependencies, "workspace.settings.manage", (req) =>
    parseUuid(req.params.workspaceId, "workspaceId"),
  );

  router.get(
    "/workspaces/:workspaceId/email-connections",
    workspaceSession,
    settingsRead,
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        const connections = await dependencies.customerEmailConnectionService.list(workspaceId);
        res.status(200).json({ connections });
      } catch (error) {
        next(error);
      }
    },
  );

  // OAuth connections eligible to back an email connection. Scoped to the email
  // providers inside the service so callers never enumerate provider IDs.
  router.get(
    "/workspaces/:workspaceId/email-oauth-connections",
    workspaceSession,
    settingsRead,
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        const connections = await dependencies.customerEmailConnectionService.listOauthConnections(workspaceId);
        res.status(200).json({ connections });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/workspaces/:workspaceId/email-connections",
    workspaceSession,
    settingsManage,
    validateBody(customerEmailConnectionCreateSchema),
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        const connection = await dependencies.customerEmailConnectionService.create(workspaceId, req.body);
        res.status(201).json({ connection });
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    "/workspaces/:workspaceId/email-connections/:connectionId",
    workspaceSession,
    settingsManage,
    validateBody(customerEmailConnectionUpdateSchema),
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        const connectionId = parseUuid(req.params.connectionId, "connectionId");
        const connection = await dependencies.customerEmailConnectionService.update(workspaceId, connectionId, req.body);
        res.status(200).json({ connection });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/workspaces/:workspaceId/email-connections/:connectionId/health-check",
    workspaceSession,
    settingsManage,
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        const connectionId = parseUuid(req.params.connectionId, "connectionId");
        const connection = await dependencies.customerEmailConnectionService.checkHealth(workspaceId, connectionId);
        res.status(200).json({ connection });
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    "/workspaces/:workspaceId/email-connections/:connectionId",
    workspaceSession,
    settingsManage,
    async (req, res, next) => {
      try {
        const workspaceId = parseUuid(req.params.workspaceId, "workspaceId");
        const connectionId = parseUuid(req.params.connectionId, "connectionId");
        await dependencies.customerEmailConnectionService.remove(workspaceId, connectionId);
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
