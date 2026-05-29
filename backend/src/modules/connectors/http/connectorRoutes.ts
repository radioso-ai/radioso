import { Router, type Request } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../../app/server/types.js";
import {
  requireWorkspaceSession,
  type WorkspaceSessionDependencies,
} from "../../../app/http/middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../../../app/http/middleware/requirePermission.js";
import type { ConnectorDetail, ConnectorSummary, ConnectorValidationIssue } from "@radioso/connector-api";

const configUpdateSchema = z.object({
  config: z.record(z.union([z.string(), z.number(), z.boolean()])),
});

const presentSummary = (summary: ConnectorSummary) => ({
  id: summary.id,
  name: summary.name,
  description: summary.description,
  enabled: summary.enabled,
  errorStatus: summary.errorStatus,
  supportsManualSync: summary.supportsManualSync,
});

const buildWebhookUrl = (
  req: Parameters<Parameters<Router["get"]>[1]>[0],
  webhookPath: string,
  workspaceId: string,
  explicitBaseUrl?: string,
): string => {
  if (explicitBaseUrl) {
    return `${explicitBaseUrl.replace(/\/$/, "")}${webhookPath.replace(":workspaceId", workspaceId)}`;
  }

  const forwardedProto = req.get("x-forwarded-proto");
  const forwardedHost = req.get("x-forwarded-host");
  const forwardedPrefix = req.get("x-forwarded-prefix") ?? "";
  const host = forwardedHost ?? req.get("host");
  const protocol = forwardedProto ?? req.protocol ?? "http";
  const prefix = forwardedPrefix.endsWith("/") ? forwardedPrefix.slice(0, -1) : forwardedPrefix;
  return `${protocol}://${host}${prefix}${webhookPath.replace(":workspaceId", workspaceId)}`;
};

const presentDetail = (
  req: Parameters<Parameters<Router["get"]>[1]>[0],
  workspaceId: string,
  detail: ConnectorDetail,
  explicitBaseUrl?: string,
) => ({
  ...presentSummary(detail),
  schema: detail.configSchema,
  config: detail.config ?? {},
  webhookUrl: buildWebhookUrl(req, detail.webhookPath, workspaceId, explicitBaseUrl),
  syncState: detail.syncState,
});

const validationError = (issues: ConnectorValidationIssue[]) => ({
  error: "Validation failed",
  fields: issues,
});

const connectorIdFromParams = (req: Request): string => {
  const value = req.params.connectorId;
  return Array.isArray(value) ? (value[0] ?? "") : value;
};

/**
 * REST endpoints for connector management (admin-facing, auth required).
 * Mounted at /api/v1/connectors.
 */
type ConnectorRouteDependencies = WorkspaceSessionDependencies &
  Pick<AppDependencies, "accountAccessService" | "connectorDb" | "connectorRegistry" | "env">;

export const createConnectorRoutes = (dependencies: ConnectorRouteDependencies): Router => {
  const router = Router();
  const registry = dependencies.connectorRegistry;
  const db = dependencies.connectorDb;
  const connectorRead = requireWorkspacePermission(dependencies, "workspace.settings.read");
  const connectorManage = requireWorkspacePermission(dependencies, "workspace.credentials.manage");

  router.use(requireWorkspaceSession(dependencies));

  // GET /api/v1/connectors — List all available connectors with per-workspace status
  router.get("/", connectorRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const connectors = await registry.listConnectors(db, workspaceId);
      res.status(200).json({ connectors: connectors.map(presentSummary) });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/connectors/:connectorId — Get detail including schema + config
  router.get("/:connectorId", connectorManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const connectorId = connectorIdFromParams(req);
      const detail = await registry.getConnectorDetail(db, workspaceId, connectorId);
      if (!detail) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }
      res.status(200).json(presentDetail(req, workspaceId, detail, dependencies.env.CONNECTOR_PUBLIC_BASE_URL));
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/v1/connectors/:connectorId — Save connector config
  router.put("/:connectorId", connectorManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const connectorId = connectorIdFromParams(req);
      if (!registry.getPlugin(connectorId)) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }

      const parsed = configUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(validationError([{ key: "config", message: "Config payload is required" }]));
        return;
      }

      const result = await registry.saveConfig(db, workspaceId, connectorId, parsed.data.config);
      if (result.kind === "validation_error") {
        res.status(400).json(validationError(result.issues));
        return;
      }
      if (result.kind === "conflict") {
        res.status(409).json({ error: "Channel identity conflict", detail: result.detail });
        return;
      }
      const detail = await registry.getConnectorDetail(db, workspaceId, connectorId);
      res.status(200).json(presentDetail(req, workspaceId, detail!, dependencies.env.CONNECTOR_PUBLIC_BASE_URL));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/v1/connectors/:connectorId/enable
  router.post("/:connectorId/enable", connectorManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const connectorId = connectorIdFromParams(req);
      if (!registry.getPlugin(connectorId)) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }
      const result = await registry.enableConnector(db, workspaceId, connectorId);
      if (result.kind === "validation_error") {
        res.status(400).json(validationError(result.issues));
        return;
      }
      if (result.kind === "conflict") {
        res.status(409).json({ error: "Channel identity conflict", detail: result.detail });
        return;
      }
      const detail = await registry.getConnectorDetail(db, workspaceId, connectorId);
      res.status(200).json(presentDetail(req, workspaceId, detail!, dependencies.env.CONNECTOR_PUBLIC_BASE_URL));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/v1/connectors/:connectorId/disable
  router.post("/:connectorId/disable", connectorManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const connectorId = connectorIdFromParams(req);
      if (!registry.getPlugin(connectorId)) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }
      await registry.disableConnector(db, workspaceId, connectorId);
      const detail = await registry.getConnectorDetail(db, workspaceId, connectorId);
      res.status(200).json(presentDetail(req, workspaceId, detail!, dependencies.env.CONNECTOR_PUBLIC_BASE_URL));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/v1/connectors/:connectorId/sync
  router.post("/:connectorId/sync", connectorManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const connectorId = connectorIdFromParams(req);
      if (!registry.getPlugin(connectorId)) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }
      const result = await registry.syncConnector(db, workspaceId, connectorId);
      if (result.kind === "unsupported") {
        res.status(409).json({ error: "Manual sync unsupported" });
        return;
      }
      if (result.kind === "already_running") {
        res.status(409).json({ error: "Connector sync already running" });
        return;
      }
      if (result.kind === "validation_error") {
        res.status(400).json(validationError(result.issues));
        return;
      }
      res.status(202).json({ accepted: result.accepted });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
