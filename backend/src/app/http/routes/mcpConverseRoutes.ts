import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { badRequest } from "../../../shared/domain/errors.js";
// Type-only imports keep these module-owned services out of the route's runtime dependency graph;
// the instances are built in app composition (mcpConverseModule) and injected.
import type { AgentConverseAudit, AgentConverseService } from "../../../modules/chat/contracts/index.js";
import type { AgentConverseResourceService } from "../../../modules/documents/contracts/index.js";
import type { AgentConverseGroundedAnswerService } from "../../../modules/retrieval/public.js";
import type { AgentConverseSessionPort } from "../../../modules/settings/contracts/agentConverseSession.js";
import {
  presentMcpConverseGroundedAnswer,
  presentMcpConverseResource,
  presentMcpConverseResourceList,
} from "../presenters/mcpConverseResourcePresenter.js";
import { requirePublicChatPermission } from "../middleware/requirePermission.js";
import { rejectWorkspaceBearerToken, requireMcpConverseSession, type McpConverseLocals } from "../middleware/requireMcpConverseSession.js";
import { validateBody } from "../middleware/validate.js";
import {
  mcpConverseAskRequestSchema,
  mcpConverseGroundedAnswerRequestSchema,
  mcpConverseResourceParamsSchema,
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
  | "documentRepository"
  | "documentStorage"
  | "env"
  | "retrievalAnswerService"
  | "workspaceInvalidationPublisher"
>;

export interface McpConverseRouteServices {
  audit: AgentConverseAudit;
  sessionService: AgentConverseSessionPort;
  converseService: AgentConverseService;
  groundedAnswerService: AgentConverseGroundedAnswerService;
  resourceService: AgentConverseResourceService;
}

export const createMcpConverseRoutes = (
  dependencies: McpConverseRouteDependencies,
  services: McpConverseRouteServices,
): Router => {
  const router = Router();
  const { audit, sessionService, converseService, groundedAnswerService, resourceService } = services;

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

  router.post(
    "/grounded-answer",
    requireMcpConverseSession(sessionService, audit),
    requirePublicChatPermission(dependencies, "public_chat.retrieval.query"),
    validateBody(mcpConverseGroundedAnswerRequestSchema),
    async (req, res, next) => {
      try {
        const { mcpConversePrincipal } = res.locals as typeof res.locals & McpConverseLocals;
        const result = await groundedAnswerService.answer(mcpConversePrincipal, req.body);
        res.status(200).json(presentMcpConverseGroundedAnswer(result));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/resources",
    requireMcpConverseSession(sessionService, audit),
    requirePublicChatPermission(dependencies, "public_chat.documents.read.scoped"),
    async (_req, res, next) => {
      try {
        const { mcpConversePrincipal } = res.locals as typeof res.locals & McpConverseLocals;
        const resources = await resourceService.list(mcpConversePrincipal);
        res.status(200).json(presentMcpConverseResourceList(resources));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/resources/:resourceId",
    requireMcpConverseSession(sessionService, audit),
    requirePublicChatPermission(dependencies, "public_chat.documents.read.scoped"),
    async (req, res, next) => {
      const params = mcpConverseResourceParamsSchema.safeParse(req.params);
      if (!params.success) {
        next(badRequest("Invalid request parameters", params.error.flatten()));
        return;
      }
      try {
        const { mcpConversePrincipal } = res.locals as typeof res.locals & McpConverseLocals;
        const resource = await resourceService.read(mcpConversePrincipal, params.data.resourceId);
        res.status(200).json(presentMcpConverseResource(resource));
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
