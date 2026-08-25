import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";

import type { Env } from "../../app/config/env.js";
import { requireWorkspaceSession } from "../../app/http/middleware/requireWorkspaceSession.js";
import type { WorkspaceSessionDependencies } from "../../app/http/middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../../app/http/middleware/requirePermission.js";
import { validateBody } from "../../app/http/middleware/validate.js";
import { forbidden, notFound, serviceUnavailable } from "../../shared/domain/errors.js";
import { summarizeProposalEvidence } from "./proposalEvidence.js";
import type { LlmCapabilityResolveInput } from "../../shared/infra/llm/workspaceContext.js";
import { copilotTurnRequestSchema, type CopilotConversation, type CopilotMessage, type CopilotSseEvent, CopilotConflictError, CopilotNotFoundError } from "./public.js";
import type { OperatorCopilotService } from "./public.js";
import { hasAllCopilotToolPermissions } from "./catalog.js";

const conversationParamsSchema = z.object({ conversationId: z.string().uuid() });
const proposalParamsSchema = z.object({ proposalId: z.string().uuid() });
/**
 * The permissions resolved per turn and handed to the catalog filter. A descriptor whose
 * requiredPermissions member is absent here is silently dropped from every live turn, so this list must
 * cover the whole catalog — asserted by copilot-catalog-shape.test.ts.
 */
export const copilotToolPermissions = ["workspace.agents.read", "workspace.agents.manage", "workspace.chat.use", "workspace.history.read", "workspace.documents.read", "workspace.retrieval.query", "workspace.quality.read", "workspace.settings.read"] as const;

export interface CopilotRouteDependencies extends WorkspaceSessionDependencies {
  env: Env;
  accountAccessService: WorkspaceSessionDependencies["accountAccessService"] & {
    hasPermission(input: {
      accountId: string;
      userId: string;
      principal: { type: "session_user"; userId: string };
      workspaceId: string;
      permission: typeof copilotToolPermissions[number];
    }): Promise<boolean>;
  };
  llmCapabilityResolver: ChatCapabilityProbePort;
  operatorCopilotService: OperatorCopilotService;
}

/** Ray only asks whether the workspace has a usable chat model; it never resolves a call config. */
interface ChatCapabilityProbePort {
  resolve(capability: "chat", input: LlmCapabilityResolveInput): Promise<unknown>;
}

export const createCopilotRoutes = (dependencies: CopilotRouteDependencies): Router => {
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
        reason: result.proposal.reason ?? null,
        appliedRef: result.proposal.appliedRef,
        // The same counts the card states, plus the cases behind them, so expanding the card
        // reads as detail on one claim rather than as a second, differently shaped one.
        evidence: result.proposal.evidence ? summarizeProposalEvidence(result.proposal.evidence) : undefined,
        evidenceCases: result.proposal.evidence?.cases ?? null,
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
      const resolvedPermissions = new Set<string>();
      for (const permission of copilotToolPermissions) if (await dependencies.accountAccessService.hasPermission({ accountId, userId, principal, workspaceId, permission })) resolvedPermissions.add(permission);
      const permissions = new Set(copilotToolPermissions.filter((permission) =>
        hasAllCopilotToolPermissions([permission], resolvedPermissions)));
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
const availability = async (dependencies: Pick<CopilotRouteDependencies, "accountAccessService" | "llmCapabilityResolver">, res: Response): Promise<{ available: boolean; reason: "ok" | "no_llm_capability"; canManage: boolean }> => {
  const { workspaceId, accountId, userId, principal } = sessionLocals(res);
  const canManage = await dependencies.accountAccessService.hasPermission({ accountId, userId, principal, workspaceId, permission: "workspace.agents.manage" });
  try {
    await dependencies.llmCapabilityResolver.resolve("chat", { workspaceId });
    return { available: true, reason: "ok", canManage };
  } catch {
    return { available: false, reason: "no_llm_capability", canManage };
  }
};
const presentConversation = (result: { conversation: CopilotConversation; messages: ReadonlyArray<CopilotMessage> }): unknown => ({ id: result.conversation.id, title: result.conversation.title, status: result.conversation.status, messages: result.messages.map((message) => ({ id: message.id, role: message.role, content: message.content, createdAt: message.createdAt.toISOString(), ...(message.role === "copilot" ? { outcome: message.outcome, activity: message.activity ?? [], proposals: message.proposals ?? [] } : {}) })) });
const sendCopilotSse = async (res: Response, events: AsyncIterable<CopilotSseEvent>): Promise<void> => {
  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();
  res.status(200).setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  for (let next = first; !next.done; next = await iterator.next()) {
    if (!res.writableEnded) res.write(`event: ${next.value.event}\ndata: ${JSON.stringify(next.value.data)}\n\n`);
  }
  if (!res.writableEnded) res.end();
};
