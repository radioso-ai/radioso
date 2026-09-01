import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { createAccountRoutes } from "./accountRoutes.js";
import { createAccountUserRoutes } from "./accountUserRoutes.js";
import { createAuthRoutes } from "./authRoutes.js";
import { createConversationOwnershipRoutes } from "./conversationOwnershipRoutes.js";
import { createContextVariableRoutes } from "./contextVariableRoutes.js";
import { createDecisionRoutes } from "./decisionRoutes.js";
import { createDecisionsQueryRoutes } from "./decisionsQueryRoutes.js";
import { createAssistantRoutes } from "./assistantRoutes.js";
import { createAgentRoutes } from "./agentRoutes.js";
import { createAgentExternalSkillsRoutes } from "./agentExternalSkillsRoutes.js";
import { createDocumentRoutes } from "./documentRoutes.js";
import { createHistoryRoutes } from "./historyRoutes.js";
import { createMetricsRoutes } from "./metricsRoutes.js";
import { createObservabilityRoutes } from "./observabilityRoutes.js";
import { createSettingsRoutes } from "./settingsRoutes.js";
import { createSettingsCredentialsRoutes } from "./settingsCredentialsRoutes.js";
import { createSettingsLlmModelsRoutes } from "./settingsLlmModelsRoutes.js";
import { createSettingsWebhookDestinationRoutes } from "./settingsWebhookDestinationRoutes.js";
import { createWorkspaceRoutes } from "./workspaceRoutes.js";
import { createOauthConnectionRoutes } from "./oauthConnectionRoutes.js";
import { createCustomerEmailConnectionRoutes } from "./customerEmailConnectionRoutes.js";
import { createSlackConnectionRoutes } from "./slackConnectionRoutes.js";
import { createEmailSkillRoutes } from "./emailSkillRoutes.js";
import { createWebhookSkillRoutes } from "./webhookSkillRoutes.js";
import { createSlackSkillRoutes } from "./slackSkillRoutes.js";
import { createAgentSkillRoutes } from "./agentSkillRoutes.js";
import { createEmailSkillActivityRoutes } from "./emailSkillActivityRoutes.js";
import { createRetrievalRoutes } from "./retrievalRoutes.js";
import { createConnectorRoutes } from "../../../modules/connectors/http/connectorRoutes.js";
import { createPublicChatRoutes } from "./publicChatRoutes.js";
import { createSkillRoutes } from "./skillRoutes.js";
import { createEvalRoutes } from "../../../modules/eval/composition.js";
import { getMcpStatus } from "../../server/mcpStatus.js";
import { createCopilotRoutes } from "../../../modules/operatorCopilot/routes.js";
import { createApiAccessRoutes } from "./apiAccessRoutes.js";

export type ApiRouteMount = {
  path: string;
  createRouter: (dependencies: AppDependencies) => Router;
};

/**
 * The public API's mount table. The route-policy contract inspects every router here
 * and every application contribution, then discovers authentication structurally.
 */
export const createApiRouteMounts = (dependencies: AppDependencies): readonly ApiRouteMount[] => [
  { path: "/api/v1/auth", createRouter: createAuthRoutes },
  { path: "/api/v1/account", createRouter: createAccountRoutes },
  { path: "/api/v1/account", createRouter: createAccountUserRoutes },
  { path: "/api/v1/account", createRouter: createApiAccessRoutes },
  { path: "/api/v1/workspace", createRouter: createWorkspaceRoutes },
  { path: "/api/v1", createRouter: createOauthConnectionRoutes },
  { path: "/api/v1", createRouter: createCustomerEmailConnectionRoutes },
  { path: "/api/v1", createRouter: createSlackConnectionRoutes },
  { path: "/api/v1", createRouter: createEmailSkillActivityRoutes },
  { path: "/api/v1/agents", createRouter: createAgentRoutes },
  { path: "/api/v1", createRouter: createContextVariableRoutes },
  { path: "/api/v1/agents", createRouter: createDecisionRoutes },
  { path: "/api/v1/decisions", createRouter: createDecisionsQueryRoutes },
  { path: "/api/v1/agents", createRouter: createAgentExternalSkillsRoutes },
  { path: "/api/v1/agents", createRouter: createEmailSkillRoutes },
  { path: "/api/v1/agents", createRouter: createWebhookSkillRoutes },
  { path: "/api/v1/agents", createRouter: createSlackSkillRoutes },
  { path: "/api/v1/agents", createRouter: createAgentSkillRoutes },
  { path: "/api/v1/assistant", createRouter: createAssistantRoutes },
  { path: "/api/v1/copilot", createRouter: createCopilotRoutes },
  { path: "/api/v1/conversations", createRouter: createConversationOwnershipRoutes },
  { path: "/api/v1/history", createRouter: createHistoryRoutes },
  { path: "/api/v1/observability", createRouter: createObservabilityRoutes },
  { path: "/api/v1/retrieval", createRouter: createRetrievalRoutes },
  { path: "/api/v1/skills", createRouter: createSkillRoutes },
  { path: "/api/v1/settings", createRouter: createSettingsRoutes },
  { path: "/api/v1/settings/credentials", createRouter: createSettingsCredentialsRoutes },
  { path: "/api/v1/settings/llm-models", createRouter: createSettingsLlmModelsRoutes },
  { path: "/api/v1/settings/webhook-destinations", createRouter: createSettingsWebhookDestinationRoutes },
  { path: "/api/v1/connectors", createRouter: createConnectorRoutes },
  { path: "/api/v1/document", createRouter: createDocumentRoutes },
  {
    path: "/api/v1/evals",
    createRouter: (appDependencies) => createEvalRoutes({
      ...appDependencies,
      snapshotService: appDependencies.evalSnapshotService,
      messageCaseService: appDependencies.evalMessageCaseService,
      caseService: appDependencies.evalCaseService,
      runService: appDependencies.evalRunService,
      suiteService: appDependencies.evalSuiteService,
    }),
  },
  { path: "/api/v1/public/chat", createRouter: createPublicChatRoutes },
];

export const createApiRouter = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/health", (_req, res) => {
    const mcp = getMcpStatus(dependencies.env);
    res.status(mcp.ready ? 200 : 503).json({
      mcp,
      status: mcp.ready ? "ok" : "starting",
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
  for (const mount of createApiRouteMounts(dependencies)) {
    router.use(mount.path, mount.createRouter(dependencies));
  }
  for (const mount of dependencies.applicationRouteMounts) {
    router.use(mount.path, mount.createRouter(dependencies));
  }
  router.use("/api/connectors", dependencies.connectorRegistry.getRouter());

  return router;
};
