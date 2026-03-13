import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { createAccountRoutes } from "./accountRoutes.js";
import { createAuthRoutes } from "./authRoutes.js";
import { createChatRoutes } from "./chatRoutes.js";
import { createDocumentRoutes } from "./documentRoutes.js";
import { createSettingsRoutes } from "./settingsRoutes.js";

export const createApiRouter = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  router.use("/api/v1/auth", createAuthRoutes(dependencies));
  router.use("/api/v1/account", createAccountRoutes(dependencies));
  router.use("/api/v1/settings", createSettingsRoutes(dependencies));
  router.use("/api/v1/document", createDocumentRoutes(dependencies));
  router.use("/api/v1/chat", createChatRoutes(dependencies));

  return router;
};
