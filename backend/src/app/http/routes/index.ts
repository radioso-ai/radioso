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
import { createMcpContextRoutes } from "./mcpContextRoutes.js";
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
import { getMcpMountStatus } from "../../server/mcpMount.js";
import { createCopilotRoutes } from "../../../modules/operatorCopilot/routes.js";
import { createApiAccessRoutes } from "./apiAccessRoutes.js";

export type ApiRouteMount = {
  path: string;
  createRouter: (dependencies: AppDependencies) => Router;
  /** Routes behind an API-principal-aware authenticator need a policy decision. */
  principalPolicyInventory: boolean;
};

/**
 * The public API's mount table. Keeping the runtime mounts and the principal-policy
 * inventory on one declaration means the contract can inspect the same routers the
 * application mounts, including routers that authenticate with `router.use`.
 */
export const createApiRouteMounts = (dependencies: AppDependencies): readonly ApiRouteMount[] => [
  { path: "/api/v1/auth", createRouter: createAuthRoutes, principalPolicyInventory: false },
  { path: "/api/v1/account", createRouter: createAccountRoutes, principalPolicyInventory: false },
  { path: "/api/v1/account", createRouter: createAccountUserRoutes, principalPolicyInventory: false },
  { path: "/api/v1/account", createRouter: createApiAccessRoutes, principalPolicyInventory: true },
  { path: "/api/v1/workspace", createRouter: createWorkspaceRoutes, principalPolicyInventory: true },
  { path: "/api/v1/workspace/mcp", createRouter: createMcpContextRoutes, principalPolicyInventory: true },
  { path: "/api/v1", createRouter: createOauthConnectionRoutes, principalPolicyInventory: true },
  { path: "/api/v1", createRouter: createCustomerEmailConnectionRoutes, principalPolicyInventory: true },
  { path: "/api/v1", createRouter: createSlackConnectionRoutes, principalPolicyInventory: true },
  { path: "/api/v1", createRouter: createEmailSkillActivityRoutes, principalPolicyInventory: true },
  { path: "/api/v1/agents", createRouter: createAgentRoutes, principalPolicyInventory: true },
  { path: "/api/v1", createRouter: createContextVariableRoutes, principalPolicyInventory: true },
  { path: "/api/v1/agents", createRouter: createDecisionRoutes, principalPolicyInventory: true },
  { path: "/api/v1/decisions", createRouter: createDecisionsQueryRoutes, principalPolicyInventory: true },
  { path: "/api/v1/agents", createRouter: createAgentExternalSkillsRoutes, principalPolicyInventory: true },
  { path: "/api/v1/agents", createRouter: createEmailSkillRoutes, principalPolicyInventory: true },
  { path: "/api/v1/agents", createRouter: createWebhookSkillRoutes, principalPolicyInventory: true },
  { path: "/api/v1/agents", createRouter: createSlackSkillRoutes, principalPolicyInventory: true },
  { path: "/api/v1/agents", createRouter: createAgentSkillRoutes, principalPolicyInventory: true },
  { path: "/api/v1/assistant", createRouter: createAssistantRoutes, principalPolicyInventory: true },
  { path: "/api/v1/copilot", createRouter: createCopilotRoutes, principalPolicyInventory: true },
  { path: "/api/v1/conversations", createRouter: createConversationOwnershipRoutes, principalPolicyInventory: true },
  { path: "/api/v1/history", createRouter: createHistoryRoutes, principalPolicyInventory: true },
  { path: "/api/v1/observability", createRouter: createObservabilityRoutes, principalPolicyInventory: false },
  { path: "/api/v1/retrieval", createRouter: createRetrievalRoutes, principalPolicyInventory: true },
  { path: "/api/v1/skills", createRouter: createSkillRoutes, principalPolicyInventory: true },
  { path: "/api/v1/settings", createRouter: createSettingsRoutes, principalPolicyInventory: true },
  { path: "/api/v1/settings/credentials", createRouter: createSettingsCredentialsRoutes, principalPolicyInventory: true },
  { path: "/api/v1/settings/llm-models", createRouter: createSettingsLlmModelsRoutes, principalPolicyInventory: true },
  { path: "/api/v1/settings/webhook-destinations", createRouter: createSettingsWebhookDestinationRoutes, principalPolicyInventory: true },
  { path: "/api/v1/connectors", createRouter: createConnectorRoutes, principalPolicyInventory: true },
  { path: "/api/v1/document", createRouter: createDocumentRoutes, principalPolicyInventory: true },
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
    principalPolicyInventory: true,
  },
  { path: "/api/v1/public/chat", createRouter: createPublicChatRoutes, principalPolicyInventory: false },
];

export const createApiRouter = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/health", (_req, res) => {
    const mcp = getMcpMountStatus(dependencies.env);
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
