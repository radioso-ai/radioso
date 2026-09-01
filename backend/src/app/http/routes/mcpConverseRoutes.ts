import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
// Type-only imports keep these module-owned services out of the route's runtime dependency graph;
// the instances are built in app composition (mcpConverseModule) and injected.
import type { AgentConverseAudit, AgentConverseService } from "../../../modules/chat/contracts/index.js";
import type { AgentConverseSessionPort } from "../../../modules/settings/contracts/agentConverseSession.js";
import { requirePublicChatPermission } from "../middleware/requirePermission.js";
import { requireMcpConverseSession, type McpConverseLocals } from "../middleware/requireMcpConverseSession.js";
import { agentChannelChatRateLimiters } from "../middleware/agentChannelRateLimiter.js";
import { validateBody } from "../middleware/validate.js";
import {
  mcpConverseAskRequestSchema,
  mcpConverseSessionRequestSchema,
  mcpConverseSessionValidateRequestSchema,
} from "../schemas/mcpConverseSchemas.js";

export type McpConverseRouteDependencies = Pick<
  AppDependencies,
  | "accessGrantService"
  | "accountAccessService"
  | "agentRepository"
  | "assistantChatService"
  | "auditService"
  | "conversationRepository"
  | "env"
  | "workspaceInvalidationPublisher"
  | "abuseControlService"
>;

export interface McpConverseRouteServices {
  audit: AgentConverseAudit;
  sessionService: AgentConverseSessionPort;
  converseService: AgentConverseService;
}

export const createMcpConverseRoutes = (
  dependencies: McpConverseRouteDependencies,
  services: McpConverseRouteServices,
): Router => {
  const router = Router();
  const { audit, sessionService, converseService } = services;
  const rateLimitMcpAsk = agentChannelChatRateLimiters(dependencies, "mcp");

  router.post(
    "/session",
    validateBody(mcpConverseSessionRequestSchema),
    async (req, res, next) => {
      try {
        const session = await sessionService.exchange(req.body);
        res.status(201).json({
          sessionToken: session.sessionToken,
          expiresAt: session.expiresAt,
          agent: session.agent,
          conversationId: session.publicSessionId,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/session/validate",
    validateBody(mcpConverseSessionValidateRequestSchema),
    async (req, res, next) => {
      try {
        const principal = await sessionService.validate(req.body.sessionToken);
        res.status(200).json({
          valid: true,
          workspaceId: principal.workspaceId,
          agentId: principal.agentId,
          conversationId: principal.publicSessionId,
          permissions: sessionService.permissions(),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/ask",
    requireMcpConverseSession(sessionService),
    ...rateLimitMcpAsk,
    requirePublicChatPermission(dependencies, "public_chat.turn.create"),
    validateBody(mcpConverseAskRequestSchema),
    async (req, res, next) => {
      try {
        const { mcpConversePrincipal } = res.locals as typeof res.locals & McpConverseLocals;
        const result = await converseService.askAgent(mcpConversePrincipal, req.body);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
