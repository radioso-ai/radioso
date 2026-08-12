import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../app/server/types.js";
import { requireWorkspaceSession } from "../../app/http/middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../../app/http/middleware/requirePermission.js";
import { validateBody } from "../../app/http/middleware/validate.js";
import { forbidden, notFound, serviceUnavailable } from "../../shared/domain/errors.js";
import { copilotTurnRequestSchema, type CopilotConversation, type CopilotMessage, type CopilotSseEvent, CopilotConflictError, CopilotNotFoundError } from "./public.js";

const conversationParamsSchema = z.object({ conversationId: z.string().uuid() });
const proposalParamsSchema = z.object({ proposalId: z.string().uuid() });
const toolPermissions = ["workspace.agents.read", "workspace.agents.manage", "workspace.history.read", "workspace.documents.read", "workspace.retrieval.query", "workspace.quality.read"] as const;

export const createCopilotRoutes = (dependencies: Pick<AppDependencies, "env" | "authService" | "workspaceSessionService" | "accountAccessService" | "llmCapabilityResolver" | "operatorCopilotService">): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const agentRead = requireWorkspacePermission(dependencies, "workspace.agents.read");
  const agentManage = requireWorkspacePermission(dependencies, "workspace.agents.manage");
  const sessionOnly = rejectBearer();
  router.use(workspaceSession, sessionOnly, agentRead);

  router.get("/availability", async (_req, res, next) => {
    try { res.status(200).json(await availability(dependencies, res)); } catch (error) { next(error); }
  });
  router.get("/conversations", async (_req, res, next) => {
    try { const { workspaceId, userId } = sessionLocals(res); res.status(200).json({ conversations: await dependencies.operatorCopilotService.list(workspaceId, userId) }); } catch (error) { next(error); }
  });
  router.get("/conversations/:conversationId", async (req, res, next) => {
    try { const { workspaceId, userId } = sessionLocals(res); const { conversationId } = conversationParamsSchema.parse(req.params); const result = await dependencies.operatorCopilotService.get(workspaceId, userId, conversationId); if (!result) throw notFound("Copilot conversation not found"); res.status(200).json(presentConversation(result)); } catch (error) { next(error); }
  });
  router.delete("/conversations/:conversationId", async (req, res, next) => {
    try { const { workspaceId, userId } = sessionLocals(res); const { conversationId } = conversationParamsSchema.parse(req.params); const deleted = await dependencies.operatorCopilotService.delete(workspaceId, userId, conversationId); if (!deleted) throw notFound("Copilot conversation not found"); res.status(204).end(); } catch (error) { next(error); }
  });
  router.get("/proposals/:proposalId", async (req, res, next) => {
    try {
      const { workspaceId, userId } = sessionLocals(res);
      const { proposalId } = proposalParamsSchema.parse(req.params);
      const result = await dependencies.operatorCopilotService.getProposal({ workspaceId, operatorUserId: userId, proposalId });
      if (!result) throw notFound("Copilot proposal not found");
      res.status(200).json({
        id: result.proposal.id,
        targetType: result.proposal.targetType,
        targetRef: result.proposal.targetRef,
        target: { type: result.proposal.targetType, ref: result.proposal.targetRef },
        targetLabel: result.preview.targetLabel,
        status: result.proposal.status,
        preview: result.preview,
        currentVersionMatches: result.currentVersionMatches,
        appliedRef: result.proposal.appliedRef,
      });
    } catch (error) { next(error); }
  });
  router.post("/proposals/:proposalId/apply", agentManage, async (req, res, next) => {
    try {
      const { workspaceId, accountId, userId } = sessionLocals(res);
      const { proposalId } = proposalParamsSchema.parse(req.params);
      res.status(200).json(await dependencies.operatorCopilotService.applyProposal({ workspaceId, accountId, operatorUserId: userId, proposalId }));
    } catch (error) {
      if (error instanceof CopilotConflictError) { res.status(409).json({ code: "conflict" }); return; }
      if (error instanceof CopilotNotFoundError) { next(notFound("Copilot proposal not found")); return; }
      next(error);
    }
  });
  router.post("/proposals/:proposalId/dismiss", async (req, res, next) => {
    try {
      const { workspaceId, accountId, userId } = sessionLocals(res);
      const { proposalId } = proposalParamsSchema.parse(req.params);
      res.status(200).json(await dependencies.operatorCopilotService.dismissProposal({ workspaceId, accountId, operatorUserId: userId, proposalId }));
    } catch (error) {
      if (error instanceof CopilotConflictError) { res.status(409).json({ code: "conflict" }); return; }
      if (error instanceof CopilotNotFoundError) { next(notFound("Copilot proposal not found")); return; }
      next(error);
    }
  });
  router.post("/turns", validateBody(copilotTurnRequestSchema), async (req, res, next) => {
    try {
      if (!(await availability(dependencies, res)).available) { res.status(503).json({ reason: "no_llm_capability" }); return; }
      const { workspaceId, accountId, userId, principal } = sessionLocals(res);
      const permissions = new Set<string>();
      for (const permission of toolPermissions) if (await dependencies.accountAccessService.hasPermission({ accountId, userId, principal, workspaceId, permission })) permissions.add(permission);
      await sendCopilotSse(res, dependencies.operatorCopilotService.runTurn({ workspaceId, accountId, operatorUserId: userId, conversationId: req.body.conversationId, message: req.body.message, pageContext: req.body.pageContext, permissions }));
    } catch (error) {
      if (error instanceof CopilotConflictError) { res.status(409).json({ code: "conflict" }); return; }
      if (error instanceof CopilotNotFoundError) { next(notFound("Copilot conversation not found")); return; }
      next(error);
    }
  });
  return router;
};

const rejectBearer = (): RequestHandler => (_req, res, next) => { if (res.locals.authMode === "bearer") { next(forbidden()); return; } next(); };
const sessionLocals = (res: Response): { workspaceId: string; accountId: string; userId: string; principal: { type: "session_user"; userId: string } } => {
  const locals = res.locals as { workspaceId: string; accountId: string; userId: string; authPrincipal: { type: "session_user"; userId: string } };
  return { workspaceId: locals.workspaceId, accountId: locals.accountId, userId: locals.userId, principal: locals.authPrincipal };
};
const availability = async (dependencies: Pick<AppDependencies, "llmCapabilityResolver">, res: Response): Promise<{ available: boolean; reason: "ok" | "no_llm_capability" }> => { try { await dependencies.llmCapabilityResolver.resolve("chat", { workspaceId: sessionLocals(res).workspaceId }); return { available: true, reason: "ok" }; } catch { return { available: false, reason: "no_llm_capability" }; } };
const presentConversation = (result: { conversation: CopilotConversation; messages: ReadonlyArray<CopilotMessage> }): unknown => ({ id: result.conversation.id, title: result.conversation.title, status: result.conversation.status, messages: result.messages.map((message) => ({ id: message.id, role: message.role, content: message.content, createdAt: message.createdAt.toISOString(), ...(message.role === "copilot" ? { outcome: message.outcome, activity: message.activity ?? [], proposals: message.proposals ?? [] } : {}) })) });
const sendCopilotSse = async (res: Response, events: AsyncIterable<CopilotSseEvent>): Promise<void> => { res.status(200).setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache"); res.setHeader("Connection", "keep-alive"); res.flushHeaders(); for await (const event of events) { if (!res.writableEnded) res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`); } if (!res.writableEnded) res.end(); };
