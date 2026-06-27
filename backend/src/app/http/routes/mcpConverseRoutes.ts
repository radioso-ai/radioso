import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { AgentConverseAudit } from "../../../modules/chat/services/agentConverseAudit.js";
import { AgentConverseService } from "../../../modules/chat/services/agentConverseService.js";
import { AgentConverseSessionService } from "../../../modules/settings/services/agentConverseSessionService.js";
import { requirePublicChatPermission } from "../middleware/requirePermission.js";
import { rejectWorkspaceBearerToken, requireMcpConverseSession, type McpConverseLocals } from "../middleware/requireMcpConverseSession.js";
import { validateBody } from "../middleware/validate.js";
import {
  mcpConverseAskRequestSchema,
  mcpConverseSessionRequestSchema,
  mcpConverseSessionValidateRequestSchema,
} from "../schemas/mcpConverseSchemas.js";

type McpConverseRouteDependencies = Pick<
  AppDependencies,
  | "accessGrantService"
  | "accountAccessService"
  | "agentRepository"
  | "assistantChatService"
  | "auditService"
  | "conversationRepository"
  | "env"
>;

export const createMcpConverseRoutes = (dependencies: McpConverseRouteDependencies): Router => {
  const router = Router();
  const audit = new AgentConverseAudit(dependencies.auditService);
  const sessionService = new AgentConverseSessionService({
    accessGrantService: dependencies.accessGrantService,
    agentRepository: dependencies.agentRepository,
    publicChatSessionSecret: dependencies.env.PUBLIC_CHAT_SESSION_SECRET,
    audit,
  });
  const converseService = new AgentConverseService({
    assistantChatService: dependencies.assistantChatService,
    conversationRepository: dependencies.conversationRepository,
    audit,
  });

  router.post(
    "/session",
    rejectWorkspaceBearerToken(audit),
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
    rejectWorkspaceBearerToken(audit),
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
    requireMcpConverseSession(sessionService, audit),
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
