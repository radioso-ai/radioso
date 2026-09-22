import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
// The services are type-only imports: their instances are built in app composition
// (mcpConverseModule) and injected.
import type { AgentConverseAudit, AgentConverseService } from "../../../modules/chat/contracts/index.js";
import type { AgentConverseSessionPort } from "../../../modules/settings/contracts/agentConverseSession.js";
import { requirePublicChatPermission } from "../middleware/requirePermission.js";
import { requireMcpConverseSession, type McpConverseLocals } from "../middleware/requireMcpConverseSession.js";
import { agentChannelChatRateLimiters } from "../middleware/agentChannelRateLimiter.js";
import { createMcpConverseSourceRateLimiter, createMcpConverseTokenRateLimiter } from "../middleware/mcpConverseSessionRateLimiter.js";
import { validateBody } from "../middleware/validate.js";
import { onSuccessfulHttpResponse } from "../middleware/httpResponseCompletion.js";
import { requireValidMcpSourceProof } from "../middleware/preAuthSourceRateLimiter.js";
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
  | "agentConverseSessionMappingRepository"
  | "assistantChatService"
  | "auditService"
  | "conversationRepository"
  | "env"
  | "metricsRegistry"
  | "workspaceInvalidationPublisher"
  | "abuseControlService"
  | "agentToolCatalog"
  | "logger"
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
  const { sessionService, converseService } = services;
  const rateLimitMcpAsk = agentChannelChatRateLimiters(dependencies, "mcp");
  const rateLimitMcpSource = createMcpConverseSourceRateLimiter(dependencies);
  const rateLimitMcpToken = createMcpConverseTokenRateLimiter(dependencies);

  router.post(
    "/session",
    rateLimitMcpSource,
    validateBody(mcpConverseSessionRequestSchema),
    rateLimitMcpToken,
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
    rateLimitMcpSource,
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
    "/session/use",
    rateLimitMcpSource,
    requireValidMcpSourceProof(dependencies.env.RADIOSO_MCP_SIGNING_SECRET),
    requireMcpConverseSession(sessionService),
    async (_req, res, next) => {
      try {
        const { mcpConversePrincipal } = res.locals as typeof res.locals & McpConverseLocals;
        onSuccessfulHttpResponse(res, () => sessionService.recordSuccessfulUse(mcpConversePrincipal));
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/tools",
    rateLimitMcpSource,
    requireMcpConverseSession(sessionService),
    async (_req, res, next) => {
      try {
        const { mcpConversePrincipal } = res.locals as typeof res.locals & McpConverseLocals;
        const catalog = await dependencies.agentToolCatalog.load({
          workspaceId: mcpConversePrincipal.workspaceId,
          agentId: mcpConversePrincipal.agentId,
        });
        onSuccessfulHttpResponse(res, () => sessionService.recordSuccessfulUse(mcpConversePrincipal));
        res.status(200).json(catalog);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/ask",
    rateLimitMcpSource,
    validateBody(mcpConverseAskRequestSchema),
    requireMcpConverseSession(sessionService),
    ...rateLimitMcpAsk,
    requirePublicChatPermission(dependencies, "public_chat.turn.create"),
    async (req, res, next) => {
      try {
        const { mcpConversePrincipal } = res.locals as typeof res.locals & McpConverseLocals;
        // The converse service binds the session's conversation and validates a tool
        // call against the release it is pinned to before any turn state is written.
        const result = await converseService.askAgent(mcpConversePrincipal, req.body);
        onSuccessfulHttpResponse(res, () => sessionService.recordSuccessfulUse(mcpConversePrincipal));
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
