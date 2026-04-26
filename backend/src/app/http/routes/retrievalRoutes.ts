import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import type { RetrievalExecutionSurface } from "../../../modules/retrieval/domain/retrievalPipelineTypes.js";

const metadataFilterSchema = z.record(z.unknown()).optional().refine(
  (val) => !val || Buffer.byteLength(JSON.stringify(val), "utf8") <= 16384,
  { message: "Metadata filter must be 16 KB or less" },
);

export const retrievalSearchSchema = z.object({
  query: z.string().min(1),
  metadataFilter: metadataFilterSchema,
  topK: z.number().int().min(1).max(100).optional(),
});

export const retrievalAnswerSchema = z.object({
  query: z.string().min(1),
  conversationContext: z.object({
    previousUserMessages: z.array(z.string().max(4000)).max(20).optional(),
    previousAssistantMessages: z.array(z.string().max(4000)).max(20).optional(),
    followUpToMessageId: z.string().max(120).optional(),
  }).optional(),
  metadataFilter: metadataFilterSchema,
});

const resolveCapabilitySurface = (header: unknown): Extract<RetrievalExecutionSurface, "retrieval" | "mcp_capability"> =>
  header === "mcp" ? "mcp_capability" : "retrieval";

export const createRetrievalRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);

  router.post("/search", workspaceSession, validateBody(retrievalSearchSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const result = await dependencies.retrievalSearchService.search({
        workspaceId,
        query: req.body.query,
        metadataFilter: req.body.metadataFilter,
        topK: req.body.topK,
        executionSurface: resolveCapabilitySurface(req.header("x-radioso-capability-client")),
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/answer", workspaceSession, validateBody(retrievalAnswerSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const result = await dependencies.retrievalAnswerService.answer({
        workspaceId,
        query: req.body.query,
        conversationContext: req.body.conversationContext,
        metadataFilter: req.body.metadataFilter,
        executionSurface: resolveCapabilitySurface(req.header("x-radioso-capability-client")),
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
