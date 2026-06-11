import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { createAccountRoutes } from "./accountRoutes.js";
import { createAccountUserRoutes } from "./accountUserRoutes.js";
import { createAuthRoutes } from "./authRoutes.js";
import { createAssistantRoutes } from "./assistantRoutes.js";
import { createAgentRoutes } from "./agentRoutes.js";
import { createDocumentRoutes } from "./documentRoutes.js";
import { createHistoryRoutes } from "./historyRoutes.js";
import { createMetricsRoutes } from "./metricsRoutes.js";
import { createObservabilityRoutes } from "./observabilityRoutes.js";
import { createSettingsRoutes } from "./settingsRoutes.js";
import { createSettingsCredentialsRoutes } from "./settingsCredentialsRoutes.js";
import { createSettingsLlmModelsRoutes } from "./settingsLlmModelsRoutes.js";
import { createSettingsWebhookDestinationRoutes } from "./settingsWebhookDestinationRoutes.js";
import { createWorkspaceRoutes } from "./workspaceRoutes.js";
import { createMcpContextRoutes } from "./mcpContextRoutes.js";
import { createRetrievalRoutes } from "./retrievalRoutes.js";
import { createConnectorRoutes } from "../../../modules/connectors/http/connectorRoutes.js";
import { createPublicChatRoutes } from "./publicChatRoutes.js";
import { createSkillRoutes } from "./skillRoutes.js";
import { createEvalRoutes } from "../../../modules/eval/composition.js";
import { getMcpMountStatus } from "../../server/mcpMount.js";

export const createApiRouter = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({
      mcp: getMcpMountStatus(dependencies.env),
      status: "ok",
    });
  });
  if (dependencies.env.METRICS_ENABLED) {
    if (!dependencies.metricsRegistry || !dependencies.env.METRICS_AUTH_TOKEN) {
      throw new Error("Metrics exposure requires a registry and METRICS_AUTH_TOKEN");
    }

    router.use(
      dependencies.env.METRICS_PATH,
      createMetricsRoutes(dependencies.metricsRegistry, dependencies.env.METRICS_AUTH_TOKEN),
    );
  }
  router.use("/api/v1/auth", createAuthRoutes(dependencies));
  router.use("/api/v1/account", createAccountRoutes(dependencies));
  router.use("/api/v1/account", createAccountUserRoutes(dependencies));
  router.use("/api/v1/workspace", createWorkspaceRoutes(dependencies));
  router.use("/api/v1/workspace/mcp", createMcpContextRoutes(dependencies));
  router.use("/api/v1/agents", createAgentRoutes(dependencies));
  router.use("/api/v1/assistant", createAssistantRoutes(dependencies));
  router.use("/api/v1/history", createHistoryRoutes(dependencies));
  router.use("/api/v1/observability", createObservabilityRoutes(dependencies));
  router.use("/api/v1/retrieval", createRetrievalRoutes(dependencies));
  router.use("/api/v1/skills", createSkillRoutes(dependencies));
  router.use("/api/v1/settings", createSettingsRoutes(dependencies));
  router.use("/api/v1/settings/credentials", createSettingsCredentialsRoutes(dependencies));
  router.use("/api/v1/settings/llm-models", createSettingsLlmModelsRoutes(dependencies));
  router.use("/api/v1/settings/webhook-destinations", createSettingsWebhookDestinationRoutes(dependencies));
  router.use("/api/v1/connectors", createConnectorRoutes(dependencies));
  router.use("/api/v1/document", createDocumentRoutes(dependencies));
  router.use("/api/v1/evals", createEvalRoutes({
    ...dependencies,
    snapshotService: dependencies.evalSnapshotService,
    caseService: dependencies.evalCaseService,
    runService: dependencies.evalRunService,
  }));
  router.use("/api/v1/public/chat", createPublicChatRoutes(dependencies));
  for (const mount of dependencies.applicationRouteMounts) {
    router.use(mount.path, mount.createRouter(dependencies));
  }
  router.use("/api/connectors", dependencies.connectorRegistry.getRouter());

  return router;
};
