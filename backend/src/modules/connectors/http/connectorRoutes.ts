import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../../app/server/types.js";
import { requireApiToken } from "../../../app/http/middleware/requireApiToken.js";
import type { ConnectorDetail, ConnectorSummary, ConnectorValidationIssue } from "../domain/connectorPlugin.js";

const configUpdateSchema = z.object({
  config: z.record(z.union([z.string(), z.number(), z.boolean()])),
});

const presentSummary = (summary: ConnectorSummary) => ({
  id: summary.id,
  name: summary.name,
  description: summary.description,
  enabled: summary.enabled,
  errorStatus: summary.errorStatus,
});

const buildWebhookUrl = (
  req: Parameters<Parameters<Router["get"]>[1]>[0],
  webhookPath: string,
  workspaceId: string,
): string => {
  const host = req.get("host");
  const protocol = req.protocol ?? "http";
  return `${protocol}://${host}${webhookPath.replace(":workspaceId", workspaceId)}`;
};

const presentDetail = (
  req: Parameters<Parameters<Router["get"]>[1]>[0],
  workspaceId: string,
  detail: ConnectorDetail,
) => ({
  ...presentSummary(detail),
  schema: detail.configSchema,
  config: detail.config ?? {},
  webhookUrl: buildWebhookUrl(req, detail.webhookPath, workspaceId),
});

const validationError = (issues: ConnectorValidationIssue[]) => ({
  error: "Validation failed",
  fields: issues,
});

/**
 * REST endpoints for connector management (admin-facing, auth required).
 * Mounted at /api/v1/connectors.
 */
export const createConnectorRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const registry = dependencies.connectorRegistry;
  const db = dependencies.connectorDb;

  router.use(requireApiToken(dependencies));

  // GET /api/v1/connectors — List all available connectors with per-workspace status
  router.get("/", async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const connectors = await registry.listConnectors(db, workspaceId);
      res.status(200).json({ connectors: connectors.map(presentSummary) });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/connectors/:connectorId — Get detail including schema + config
  router.get("/:connectorId", async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const detail = await registry.getConnectorDetail(db, workspaceId, req.params.connectorId);
      if (!detail) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }
      res.status(200).json(presentDetail(req, workspaceId, detail));
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/v1/connectors/:connectorId — Save connector config
  router.put("/:connectorId", async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      if (!registry.getPlugin(req.params.connectorId)) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }

      const parsed = configUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(validationError([{ key: "config", message: "Config payload is required" }]));
        return;
      }

      const result = await registry.saveConfig(db, workspaceId, req.params.connectorId, parsed.data.config);
      if (result.kind === "validation_error") {
        res.status(400).json(validationError(result.issues));
        return;
      }
      if (result.kind === "conflict") {
        res.status(409).json({ error: "Channel identity conflict", detail: result.detail });
        return;
      }
      const detail = await registry.getConnectorDetail(db, workspaceId, req.params.connectorId);
      res.status(200).json(presentDetail(req, workspaceId, detail!));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/v1/connectors/:connectorId/enable
  router.post("/:connectorId/enable", async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      if (!registry.getPlugin(req.params.connectorId)) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }
      const result = await registry.enableConnector(db, workspaceId, req.params.connectorId);
      if (result.kind === "validation_error") {
        res.status(400).json(validationError(result.issues));
        return;
      }
      if (result.kind === "conflict") {
        res.status(409).json({ error: "Channel identity conflict", detail: result.detail });
        return;
      }
      const detail = await registry.getConnectorDetail(db, workspaceId, req.params.connectorId);
      res.status(200).json(presentDetail(req, workspaceId, detail!));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/v1/connectors/:connectorId/disable
  router.post("/:connectorId/disable", async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      if (!registry.getPlugin(req.params.connectorId)) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }
      await registry.disableConnector(db, workspaceId, req.params.connectorId);
      const detail = await registry.getConnectorDetail(db, workspaceId, req.params.connectorId);
      res.status(200).json(presentDetail(req, workspaceId, detail!));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
