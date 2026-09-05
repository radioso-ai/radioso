import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";

import type { Env } from "../../app/config/env.js";
import { requireWorkspaceSession } from "../../app/http/middleware/requireWorkspaceSession.js";
import type { WorkspaceSessionDependencies } from "../../app/http/middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../../app/http/middleware/requirePermission.js";
import { createRateLimitMiddleware, type RateLimitAbuseControlPort, type RateLimitAuditPort } from "../../app/http/middleware/rateLimit.js";
import { validateBody } from "../../app/http/middleware/validate.js";
import { forbidden, notFound } from "../../shared/domain/errors.js";
import { copilotProposalPermissions, copilotProposalTargetTypes, type CopilotProposalTargetType } from "./contracts.js";
import { summarizeProposalEvidence } from "./proposalEvidence.js";
import type { LlmCapabilityResolveInput } from "../../shared/infra/llm/workspaceContext.js";
import { copilotTurnRequestSchema, type CopilotConversation, type CopilotMessage, type CopilotSseEvent, type CopilotToolDescriptor, CopilotAuthorizationError, CopilotConflictError, CopilotNotFoundError } from "./public.js";
import type { AccountPermission } from "../account/public.js";
import type { OperatorCopilotService } from "./public.js";
import { hasAllCopilotToolPermissions } from "./catalog.js";

/**
 * These routes are the dashboard panel and nothing else — they reject bearer auth and require a
 * workspace session. A second transport declares its own surface rather than reusing this one.
 */
const DASHBOARD_SURFACE = "dashboard" as const;

const conversationParamsSchema = z.object({ conversationId: z.string().uuid() });
const proposalParamsSchema = z.object({ proposalId: z.string().uuid() });
/**
 * The permissions this module knows a turn needs beyond what the assembled catalog declares:
 * `workspace_triage` gates individual digest sections on permissions no descriptor requires, and a
 * permission the route never resolves reports its section as unauthorized on every turn. The rest
 * of the per-turn set is derived from the catalog itself, so a contributed tool cannot ship dead
 * for want of an entry here — see `copilotResolvableToolPermissions`.
 */
export const copilotToolPermissions = ["workspace.agents.read", "workspace.agents.manage", "workspace.chat.use", "workspace.history.read", "workspace.documents.read", "workspace.documents.manage", "workspace.retrieval.query", "workspace.quality.read", "workspace.settings.read", "workspace.conversation.takeover"] as const;

/**
 * Every permission a turn resolves: this module's section-gating baseline plus whatever the
 * assembled catalog's descriptors require. Deriving the second half is what lets an application
 * module contribute a tool without also editing a list in this file.
 */
export const copilotResolvableToolPermissions = (
  catalog: ReadonlyArray<Pick<CopilotToolDescriptor, "requiredPermissions">>,
): ReadonlyArray<AccountPermission> => [...new Set<AccountPermission>([
  ...copilotToolPermissions,
  ...catalog.flatMap((descriptor) => descriptor.requiredPermissions),
])];

export interface CopilotRouteDependencies extends WorkspaceSessionDependencies {
  env: Env;
  abuseControlService: RateLimitAbuseControlPort;
  auditService: RateLimitAuditPort;
  accountAccessService: WorkspaceSessionDependencies["accountAccessService"] & {
    hasPermission(input: {
      accountId: string;
      userId: string;
      principal: { type: "session_user"; userId: string };
      workspaceId: string;
      permission: AccountPermission;
    }): Promise<boolean>;
  };
  llmCapabilityResolver: ChatCapabilityProbePort;
  operatorCopilotService: OperatorCopilotService;
  /** Read only for its permission declarations; the turn itself runs against the service's catalog. */
  copilotToolCatalog: ReadonlyArray<Pick<CopilotToolDescriptor, "requiredPermissions">>;
}

/** Ray only asks whether the workspace has a usable chat model; it never resolves a call config. */
interface ChatCapabilityProbePort {
  resolve(capability: "chat", input: LlmCapabilityResolveInput): Promise<unknown>;
}

export const createCopilotRoutes = (dependencies: CopilotRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const agentRead = requireWorkspacePermission(dependencies, "workspace.agents.read");
  const sessionOnly = rejectBearer();
  const rateLimitTurn = copilotTurnRateLimiter(dependencies);
  const resolvableToolPermissions = copilotResolvableToolPermissions(dependencies.copilotToolCatalog);
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
  // No permission middleware here on purpose: what an operator must hold to apply a proposal depends
  // on what that proposal changes, and only the stored row says which domain that is. The service
  // reads it and authorizes against copilotProposalPermissions, answering 403 the same way.
  router.post("/proposals/:proposalId/apply", async (req, res, next) => {
    try {
      const { workspaceId, accountId, userId } = sessionLocals(res);
      const { proposalId } = proposalParamsSchema.parse(req.params);
      res.status(200).json(await dependencies.operatorCopilotService.applyProposal({ workspaceId, accountId, operatorUserId: userId, surface: DASHBOARD_SURFACE, proposalId }));
    } catch (error) {
      if (error instanceof CopilotAuthorizationError) { next(forbidden()); return; }
      if (error instanceof CopilotConflictError) { res.status(409).json({ code: "conflict" }); return; }
      if (error instanceof CopilotNotFoundError) { next(notFound("Copilot proposal not found")); return; }
      next(error);
    }
  });
  router.post("/proposals/:proposalId/dismiss", async (req, res, next) => {
    try {
      const { workspaceId, accountId, userId } = sessionLocals(res);
      const { proposalId } = proposalParamsSchema.parse(req.params);
      res.status(200).json(await dependencies.operatorCopilotService.dismissProposal({ workspaceId, accountId, operatorUserId: userId, surface: DASHBOARD_SURFACE, proposalId }));
    } catch (error) {
      if (error instanceof CopilotConflictError) { res.status(409).json({ code: "conflict" }); return; }
      if (error instanceof CopilotNotFoundError) { next(notFound("Copilot proposal not found")); return; }
      next(error);
    }
  });
  router.post("/turns", rateLimitTurn, validateBody(copilotTurnRequestSchema), async (req, res, next) => {
    try {
      if (!(await availability(dependencies, res)).available) { res.status(503).json({ reason: "no_llm_capability" }); return; }
      const { workspaceId, accountId, userId, principal } = sessionLocals(res);
      const resolvedPermissions = new Set<string>();
      for (const permission of resolvableToolPermissions) if (await dependencies.accountAccessService.hasPermission({ accountId, userId, principal, workspaceId, permission })) resolvedPermissions.add(permission);
      const permissions = new Set(resolvableToolPermissions.filter((permission) =>
        hasAllCopilotToolPermissions([permission], resolvedPermissions)));
      await sendCopilotSse(res, dependencies.operatorCopilotService.runTurn({ workspaceId, accountId, operatorUserId: userId, surface: DASHBOARD_SURFACE, conversationId: req.body.conversationId, message: req.body.message, pageContext: req.body.pageContext, permissions }));
    } catch (error) {
      if (error instanceof CopilotConflictError) { res.status(409).json({ code: "conflict" }); return; }
      if (error instanceof CopilotNotFoundError) { next(notFound("Copilot conversation not found")); return; }
      next(error);
    }
  });
  return router;
};

/**
 * Keyed to the operator, not to the account.
 *
 * The dashboard's own limiter buckets a browser session by account and workspace, which is right
 * for a surface a person types into. A Ray turn is a loop the operator starts and a model runs, so
 * an account-wide bucket would let one runaway session refuse every colleague in the workspace.
 * The operator-scoped key matches how Ray's expensive tools already spend their budget, and gives
 * a Ray turn its own scope rather than competing with the operator's assistant and retrieval work.
 */
const copilotTurnRateLimiter = (dependencies: CopilotRouteDependencies): RequestHandler =>
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "api.copilot_turn",
    limit: dependencies.env.EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.EXPENSIVE_AUTHENTICATED_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (_req, res) => {
      const locals = res.locals as { accountId?: string; workspaceId?: string; userId?: string };
      if (!locals.accountId || !locals.workspaceId || !locals.userId) return null;
      return `account:${locals.accountId}:workspace:${locals.workspaceId}:operator:${locals.userId}`;
    },
    resolveAuditContext: (_req, res) => {
      const locals = res.locals as { accountId?: string; workspaceId?: string; userId?: string };
      return {
        accountId: locals.accountId ?? null,
        workspaceId: locals.workspaceId ?? null,
        metadata: { principalType: "operator_copilot", operatorUserId: locals.userId, route: "POST /api/v1/copilot/turns" },
      };
    },
  });

const rejectBearer = (): RequestHandler => (_req, res, next) => { if (res.locals.authMode === "bearer") { next(forbidden()); return; } next(); };
const sessionLocals = (res: Response): { workspaceId: string; accountId: string; userId: string; principal: { type: "session_user"; userId: string } } => {
  const locals = res.locals as { workspaceId: string; accountId: string; userId: string; authPrincipal: { type: "session_user"; userId: string } };
  return { workspaceId: locals.workspaceId, accountId: locals.accountId, userId: locals.userId, principal: locals.authPrincipal };
};
/**
 * Which proposals this operator can apply, not whether they can apply proposals. Applying writes to
 * the domain the proposal targets, so a document manager and an agent manager can each apply some
 * cards and not others; one workspace-wide flag would either hide Apply from someone entitled to it
 * or offer it where the server will refuse.
 */
const applyableProposalTargets = async (
  dependencies: Pick<CopilotRouteDependencies, "accountAccessService">,
  res: Response,
): Promise<CopilotProposalTargetType[]> => {
  const { workspaceId, accountId, userId, principal } = sessionLocals(res);
  const held = new Map<string, boolean>();
  const holds = async (permission: AccountPermission): Promise<boolean> => {
    const cached = held.get(permission);
    if (cached !== undefined) return cached;
    const allowed = await dependencies.accountAccessService.hasPermission({ accountId, userId, principal, workspaceId, permission });
    held.set(permission, allowed);
    return allowed;
  };
  const targets: CopilotProposalTargetType[] = [];
  for (const targetType of copilotProposalTargetTypes) {
    const permissions = copilotProposalPermissions[targetType];
    const allowed = await Promise.all(permissions.map((permission) => holds(permission)));
    if (allowed.every(Boolean)) targets.push(targetType);
  }
  return targets;
};

const availability = async (dependencies: Pick<CopilotRouteDependencies, "accountAccessService" | "llmCapabilityResolver">, res: Response): Promise<{ available: boolean; reason: "ok" | "no_llm_capability"; canManage: boolean; applyableProposalTargets: CopilotProposalTargetType[] }> => {
  const { workspaceId, accountId, userId, principal } = sessionLocals(res);
  const canManage = await dependencies.accountAccessService.hasPermission({ accountId, userId, principal, workspaceId, permission: "workspace.agents.manage" });
  const targets = await applyableProposalTargets(dependencies, res);
  try {
    await dependencies.llmCapabilityResolver.resolve("chat", { workspaceId });
    return { available: true, reason: "ok", canManage, applyableProposalTargets: targets };
  } catch {
    return { available: false, reason: "no_llm_capability", canManage, applyableProposalTargets: targets };
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
