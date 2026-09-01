import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "./openApiRegistry.js";
import { registerSystemPaths } from "./paths/systemPaths.js";
import {
  registerAssistantAuthenticatedChatPaths,
  registerAssistantFeedbackPaths,
  registerAssistantPublicChatPaths,
  registerAssistantSessionPaths,
} from "./paths/assistantPaths.js";
import { registerAuthPaths } from "./paths/authPaths.js";
import { registerAccountManagementPaths, registerAccountSessionPaths } from "./paths/accountPaths.js";
import { registerWorkspacePaths } from "./paths/workspacePaths.js";
import { registerSettingsPaths } from "./paths/settingsPaths.js";
import { registerAgentsPaths } from "./paths/agentsPaths.js";
import { registerRetrievalAnswerPaths, registerRetrievalSearchPaths } from "./paths/retrievalPaths.js";
import { registerSkillsPaths } from "./paths/skillsPaths.js";
import { registerExternalSkillsPaths } from "./paths/externalSkillsPaths.js";
import { registerOauthConnectionPaths } from "./paths/oauthConnectionPaths.js";
import { registerCustomerEmailPaths } from "./paths/customerEmailPaths.js";
import { registerSlackPaths } from "./paths/slackPaths.js";
import { registerWebhookSkillsPaths } from "./paths/webhookSkillsPaths.js";
import { registerSlackSkillsPaths } from "./paths/slackSkillsPaths.js";
import { registerAgentSkillsPaths } from "./paths/agentSkillsPaths.js";
import { registerAgentWizardPaths } from "./paths/agentWizardPaths.js";
import { registerDocumentsPaths } from "./paths/documentsPaths.js";
import { registerHistoryPaths } from "./paths/historyPaths.js";
import { registerConversationOwnershipPaths } from "./paths/conversationOwnershipPaths.js";
import { registerDecisionPaths } from "./paths/decisionPaths.js";
import { registerConnectorsPaths } from "./paths/connectorsPaths.js";
import { registerQualityPaths } from "./paths/qualityPaths.js";
import { registerEvalPaths } from "./paths/evalPaths.js";
import { registerMcpConversePaths } from "./paths/mcpConversePaths.js";
import { registerContextVariablePaths } from "./paths/contextVariablePaths.js";
import { registerAudiencePulsePaths } from "./paths/audiencePulsePaths.js";
import { registerCopilotPaths } from "./paths/copilotPaths.js";
import { registerWorkspaceEventsPaths } from "./paths/workspaceEventsPaths.js";

export const registerOpenApiPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registerSystemPaths(registry, schemas, security);
  registerAssistantSessionPaths(registry, schemas, security);
  registerAuthPaths(registry, schemas, security);
  registerAccountManagementPaths(registry, schemas, security);
  registerAccountSessionPaths(registry, schemas, security);
  registerWorkspacePaths(registry, schemas, security);
  registerSettingsPaths(registry, schemas, security);
  registerAgentsPaths(registry, schemas, security);
  registerAgentWizardPaths(registry, schemas, security);
  registerContextVariablePaths(registry, schemas, security);
  registerRetrievalSearchPaths(registry, schemas, security);
  registerSkillsPaths(registry, schemas, security);
  registerExternalSkillsPaths(registry, schemas, security);
  registerOauthConnectionPaths(registry, schemas, security);
  registerCustomerEmailPaths(registry, schemas, security);
  registerSlackPaths(registry, schemas, security);
  registerWebhookSkillsPaths(registry, schemas, security);
  registerSlackSkillsPaths(registry, schemas, security);
  registerAgentSkillsPaths(registry, schemas, security);
  registerRetrievalAnswerPaths(registry, schemas, security);
  registerDocumentsPaths(registry, schemas, security);
  registerAssistantAuthenticatedChatPaths(registry, schemas, security);
  registerAssistantFeedbackPaths(registry, schemas, security);
  registerHistoryPaths(registry, schemas, security);
  registerConversationOwnershipPaths(registry, schemas, security);
  registerDecisionPaths(registry, schemas, security);
  registerConnectorsPaths(registry, schemas, security);
  registerQualityPaths(registry, schemas, security);
  registerAudiencePulsePaths(registry, schemas, security);
  registerCopilotPaths(registry, schemas, security);
  registerEvalPaths(registry, schemas, security);
  registerMcpConversePaths(registry, schemas, security);
  registerAssistantPublicChatPaths(registry, schemas, security);
  registerWorkspaceEventsPaths(registry, schemas, security);
};
