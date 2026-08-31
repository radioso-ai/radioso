import { Router, type RequestHandler } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import type { AuthenticatedPrincipal } from "../../../modules/account/public.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { validateBody } from "../middleware/validate.js";
import { expensiveAuthenticatedRateLimiter } from "../middleware/expensiveAuthenticatedRateLimiter.js";
import { metadataFilterSchema } from "../schemas/metadataFilterSchema.js";
import { retrievalQuerySchema } from "../schemas/textInputLimits.js";
import type { RetrievalExecutionSurface } from "../../../modules/retrieval/public.js";

export const retrievalSearchSchema = z.object({
  query: retrievalQuerySchema,
  agentId: z.string().uuid().optional(),
  metadataFilter: metadataFilterSchema,
  topK: z.number().int().min(1).max(100).optional(),
  includeDebug: z.boolean().optional().default(false),
});

export const retrievalAnswerSchema = z.object({
  query: retrievalQuerySchema,
  agentId: z.string().uuid().optional(),
  conversationContext: z.object({
    previousUserMessages: z.array(z.string().max(4000)).max(20).optional(),
    previousAssistantMessages: z.array(z.string().max(4000)).max(20).optional(),
    followUpToMessageId: z.string().max(120).optional(),
  }).optional(),
  metadataFilter: metadataFilterSchema,
  includeDebug: z.boolean().optional().default(false),
});

const resolveCapabilitySurface = (header: unknown): Extract<RetrievalExecutionSurface, "retrieval" | "mcp_capability"> =>
  header === "mcp" ? "mcp_capability" : "retrieval";

const resolveRequestId = (requestId: unknown): string | undefined =>
  typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;

/**
 * Scoping a probe to an agent reads that agent's configuration, so the agent
 * read permission applies — but only to requests that name one, which keeps the
 * unscoped workspace probe reachable with retrieval access alone.
 */
const requireAgentScopePermission = (
  dependencies: RetrievalRouteDependencies,
): RequestHandler => async (req, res, next) => {
  if (!(req.body as { agentId?: string }).agentId) {
    next();
    return;
  }
  try {
    const { accountId, userId, workspaceId, authPrincipal } = res.locals as {
      accountId: string;
      userId?: string;
      workspaceId?: string;
      authPrincipal?: AuthenticatedPrincipal;
    };
    await dependencies.accountAccessService.requirePermission({
      accountId,
      userId,
      principal: authPrincipal,
      permission: "workspace.agents.read",
      workspaceId,
    });
    next();
  } catch (error) {
    next(error);
  }
};

const presentRetrievalSearchResult = <T extends {
  activitySummary: unknown;
  activityTrace: unknown;
}>(result: T, includeDebug: boolean) => {
  const { activitySummary, activityTrace, ...response } = result;
  return {
    ...response,
    ...(includeDebug ? { debug: { activitySummary, activityTrace } } : {}),
  };
};

const presentRetrievalAnswerResult = <T extends {
  outcome: string;
  evidence?: unknown;
  activitySummary?: unknown;
  activityTrace?: unknown;
}>(result: T, includeDebug: boolean) => {
  const { evidence, activitySummary, activityTrace, ...response } = result;
  const debug = {
    ...(evidence !== undefined ? { evidence } : {}),
    ...(activitySummary !== undefined ? { activitySummary } : {}),
    ...(activityTrace !== undefined ? { activityTrace } : {}),
  };
  const hasDebug = Object.keys(debug).length > 0;
  return {
    ...response,
    ...(includeDebug && hasDebug ? { debug } : {}),
  };
};

type RetrievalRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  "retrievalAnswerService" | "retrievalSearchService" | "abuseControlService" | "auditService"
>;

export const createRetrievalRoutes = (dependencies: RetrievalRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const rateLimitExpensiveAuthenticatedRequest = expensiveAuthenticatedRateLimiter(dependencies);

  router.post(
    "/search",
    workspaceSession,
    requireWorkspacePermission(dependencies, "workspace.retrieval.query"),
    validateBody(retrievalSearchSchema),
    requireAgentScopePermission(dependencies),
    rateLimitExpensiveAuthenticatedRequest,
    async (req, res, next) => {
      try {
        const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
        const result = await dependencies.retrievalSearchService.search({
          workspaceId,
          accountId: accountId ?? null,
          requestId: resolveRequestId((req as { id?: unknown }).id),
          agentId: req.body.agentId,
          query: req.body.query,
          metadataFilter: req.body.metadataFilter,
          topK: req.body.topK,
          executionSurface: resolveCapabilitySurface(req.header("x-radioso-capability-client")),
        });
        res.status(200).json(presentRetrievalSearchResult(result, req.body.includeDebug));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/answer",
    workspaceSession,
    requireWorkspacePermission(dependencies, "workspace.retrieval.query"),
    validateBody(retrievalAnswerSchema),
    requireAgentScopePermission(dependencies),
    rateLimitExpensiveAuthenticatedRequest,
    async (req, res, next) => {
      try {
        const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
        const result = await dependencies.retrievalAnswerService.answer({
          workspaceId,
          accountId: accountId ?? null,
          requestId: resolveRequestId((req as { id?: unknown }).id),
          agentId: req.body.agentId,
          query: req.body.query,
          conversationContext: req.body.conversationContext,
          metadataFilter: req.body.metadataFilter,
          executionSurface: resolveCapabilitySurface(req.header("x-radioso-capability-client")),
        });
        res.status(200).json(presentRetrievalAnswerResult(result, req.body.includeDebug));
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
