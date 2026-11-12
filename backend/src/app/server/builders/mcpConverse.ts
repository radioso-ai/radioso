import { AgentConverseAudit } from "../../../modules/chat/composition.js";
import { AgentConverseSessionService } from "../../../modules/settings/composition.js";
import type { McpConverseRouteDependencies, McpConverseRouteServices } from "../../http/routes/mcpConverseRoutes.js";
import {
  createAgentConverseOriginVerifier,
  createAgentConverseWalkInIssuer,
  createAgentConverseWalkInObserver,
} from "../../composition/agentConverseOrigins.js";
import { createAgentConverseService } from "../../composition/agentConverse.js";
import { createConverseVisitorIdentityVerifier } from "../../composition/converseVisitorIdentity.js";
import { createConversationUpdatesComposition } from "../../composition/conversationUpdates.js";

export const buildMcpConverseServices = (
  dependencies: McpConverseRouteDependencies,
): McpConverseRouteServices => {
  const audit = new AgentConverseAudit(dependencies.auditService);
  const walkInObserver = createAgentConverseWalkInObserver({
    metrics: dependencies.metricsRegistry,
    logger: dependencies.logger,
  });
  const sessionService = new AgentConverseSessionService({
    accessGrantService: dependencies.accessGrantService,
    agentLookup: dependencies.agentRepository,
    sessionMapping: dependencies.agentConverseSessionMappingRepository,
    originVerifier: createAgentConverseOriginVerifier({
      accessGrantService: dependencies.accessGrantService,
      agentRepository: dependencies.agentRepository,
      audit,
    }),
    walkInIssuer: createAgentConverseWalkInIssuer({ agentRepository: dependencies.agentRepository }),
    walkInObserver,
    publicChatSessionSecret: dependencies.env.PUBLIC_CHAT_SESSION_SECRET,
    audit,
  });
  const converseService = createAgentConverseService(dependencies, {
    audit,
    visitorIdentity: createConverseVisitorIdentityVerifier(dependencies),
  });
  const conversationUpdates = createConversationUpdatesComposition(dependencies);
  return {
    audit,
    sessionService,
    converseService,
    walkInObserver,
    conversationUpdateReader: conversationUpdates.reader,
    conversationUpdateWaiter: conversationUpdates.waiter,
  };
};
