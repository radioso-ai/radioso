import { AgentConverseService, type AgentConverseAudit } from "../../modules/chat/composition.js";
import type { ConverseVisitorIdentityVerifier } from "../../modules/chat/contracts/index.js";
import type { AppDependencies } from "../server/types.js";

type AgentConverseDependencies = Pick<
  AppDependencies,
  | "agentToolCatalog"
  | "assistantChatService"
  | "conversationRepository"
  | "logger"
  | "metricsRegistry"
  | "workspaceInvalidationPublisher"
>;

/**
 * The converse turn behind every door that holds a converse principal (MCP `ask`, A2A): the same
 * chat turn and tool catalog for each. A door hands in its own audit, and MCP
 * its visitor identity check.
 */
export const createAgentConverseService = (
  dependencies: AgentConverseDependencies,
  door: { audit: AgentConverseAudit; visitorIdentity?: ConverseVisitorIdentityVerifier },
): AgentConverseService => new AgentConverseService({
  assistantChatService: dependencies.assistantChatService,
  conversationRepository: dependencies.conversationRepository,
  agentToolCatalog: dependencies.agentToolCatalog,
  publisher: dependencies.workspaceInvalidationPublisher,
  metrics: dependencies.metricsRegistry,
  logger: dependencies.logger,
  ...door,
});
