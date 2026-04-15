import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { createAccountRoutes } from "./accountRoutes.js";
import { createAccountUserRoutes } from "./accountUserRoutes.js";
import { createAuthRoutes } from "./authRoutes.js";
import { createChatRoutes } from "./chatRoutes.js";
import { createDocumentRoutes } from "./documentRoutes.js";
import { createSettingsRoutes } from "./settingsRoutes.js";
import { createWorkspaceRoutes } from "./workspaceRoutes.js";
import { createConnectorRoutes } from "../../../modules/connectors/http/connectorRoutes.js";
import { createPublicChatRoutes } from "./publicChatRoutes.js";
import { createPublicEmbedRoutes } from "./publicEmbedRoutes.js";
import { createEvalRoutes } from "./evalRoutes.js";

export const createApiRouter = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  router.use("/api/v1/auth", createAuthRoutes(dependencies));
  router.use("/api/v1/account", createAccountRoutes(dependencies));
  router.use("/api/v1/account", createAccountUserRoutes(dependencies));
  router.use("/api/v1/workspace", createWorkspaceRoutes(dependencies));
  router.use("/api/v1/settings", createSettingsRoutes(dependencies));
  router.use("/api/v1/connectors", createConnectorRoutes(dependencies));
  router.use("/api/v1/document", createDocumentRoutes(dependencies));
  router.use("/api/v1/chat", createChatRoutes(dependencies));
  router.use("/api/v1/evals", createEvalRoutes(dependencies));
  router.use("/api/v1/public/chat", createPublicChatRoutes(dependencies));
  router.use("/api/v1/public/embed", createPublicEmbedRoutes(dependencies));
  router.use("/api/connectors", dependencies.connectorRegistry.getRouter());

  return router;
};
