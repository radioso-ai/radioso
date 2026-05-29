import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { validateBody } from "../middleware/validate.js";
import type { RetrievalExecutionSurface } from "../../../modules/retrieval/public.js";

const metadataFilterSchema = z.record(z.unknown()).optional().refine(
  (val) => !val || Buffer.byteLength(JSON.stringify(val), "utf8") <= 16384,
  { message: "Metadata filter must be 16 KB or less" },
);

export const retrievalSearchSchema = z.object({
  query: z.string().min(1),
  metadataFilter: metadataFilterSchema,
  topK: z.number().int().min(1).max(100).optional(),
  includeDebug: z.boolean().optional().default(false),
});

export const retrievalAnswerSchema = z.object({
  query: z.string().min(1),
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
  "retrievalAnswerService" | "retrievalSearchService"
>;

export const createRetrievalRoutes = (dependencies: RetrievalRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);

  router.post("/search", workspaceSession, requireWorkspacePermission(dependencies, "workspace.retrieval.query"), validateBody(retrievalSearchSchema), async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
      const result = await dependencies.retrievalSearchService.search({
        workspaceId,
        accountId: accountId ?? null,
        requestId: resolveRequestId((req as { id?: unknown }).id),
        query: req.body.query,
        metadataFilter: req.body.metadataFilter,
        topK: req.body.topK,
        executionSurface: resolveCapabilitySurface(req.header("x-radioso-capability-client")),
      });
      res.status(200).json(presentRetrievalSearchResult(result, req.body.includeDebug));
    } catch (error) {
      next(error);
    }
  });

  router.post("/answer", workspaceSession, requireWorkspacePermission(dependencies, "workspace.retrieval.query"), validateBody(retrievalAnswerSchema), async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
      const result = await dependencies.retrievalAnswerService.answer({
        workspaceId,
        accountId: accountId ?? null,
        requestId: resolveRequestId((req as { id?: unknown }).id),
        query: req.body.query,
        conversationContext: req.body.conversationContext,
        metadataFilter: req.body.metadataFilter,
        executionSurface: resolveCapabilitySurface(req.header("x-radioso-capability-client")),
      });
      res.status(200).json(presentRetrievalAnswerResult(result, req.body.includeDebug));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
