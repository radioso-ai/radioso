import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest } from "../../../shared/domain/errors.js";
import type { EvalCaseConversationMessage } from "../../../modules/evals/domain/evalTypes.js";

export const evalDatasetParamsSchema = z.object({
  datasetId: z.string().uuid(),
});

export const evalRunParamsSchema = z.object({
  datasetId: z.string().uuid(),
  runId: z.string().uuid(),
});

export const createEvalDatasetSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});

const evalCaseConversationMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1).max(2000),
});

export const createEvalCaseSchema = z.object({
  title: z.string().min(1).max(120),
  sourceType: z.enum(["manual", "conversation_import"]).optional(),
  query: z.string().min(1).max(2000),
  conversationContext: z.array(evalCaseConversationMessageSchema).max(12).optional(),
  expectations: z.object({
    expectedDocumentIds: z.array(z.string().uuid()).optional(),
    expectedCitationTitles: z.array(z.string()).optional(),
    expectedRefusalBehavior: z.enum(["refusal", "answer"]).optional(),
    expectedAnswerOutcome: z.enum(["grounded_success", "grounded_degraded_unsupported_segments", "no_context_refusal", "non_retrieval_response"]).optional(),
    requiredPhrases: z.array(z.string()).optional(),
    forbiddenPhrases: z.array(z.string()).optional(),
    latencyBudgetMs: z.number().int().positive().optional(),
  }).optional(),
  provenance: z.record(z.unknown()).optional(),
});

export const importChatHistorySchema = z.object({
  conversationId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
});

export const createEvalRunSchema = z.object({
  label: z.string().max(120).optional(),
  baselineRunId: z.string().uuid().optional(),
  runMetadata: z.record(z.unknown()).optional(),
});

export const evalComparisonQuerySchema = z.object({
  baselineRunId: z.string().uuid().optional(),
});

export const createEvalRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);

  router.get("/datasets", workspaceSession, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const datasets = await dependencies.evalLabService.listDatasets(workspaceId);
      res.status(200).json({ datasets });
    } catch (error) {
      next(error);
    }
  });

  router.post("/datasets", workspaceSession, validateBody(createEvalDatasetSchema), async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
      const dataset = await dependencies.evalLabService.createDataset(workspaceId, {
        ...req.body,
        createdByAccountId: accountId ?? null,
      });
      res.status(201).json(dataset);
    } catch (error) {
      next(error);
    }
  });

  router.get("/datasets/:datasetId", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedParams = evalDatasetParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const dataset = await dependencies.evalLabService.getDataset(workspaceId, parsedParams.data.datasetId);
      res.status(200).json(dataset);
    } catch (error) {
      next(error);
    }
  });

  router.post("/import/chat-history", workspaceSession, validateBody(importChatHistorySchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const draft = await dependencies.evalLabService.importConversationTurn(workspaceId, req.body);
      res.status(200).json({ importDraft: draft });
    } catch (error) {
      next(error);
    }
  });

  router.post("/datasets/:datasetId/cases", workspaceSession, validateBody(createEvalCaseSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedParams = evalDatasetParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const evalCase = await dependencies.evalLabService.createCase(workspaceId, parsedParams.data.datasetId, {
        ...req.body,
        conversationContext: (req.body.conversationContext ?? []) as EvalCaseConversationMessage[],
      });
      res.status(201).json(evalCase);
    } catch (error) {
      next(error);
    }
  });

  router.post("/datasets/:datasetId/runs", workspaceSession, validateBody(createEvalRunSchema), async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
      const parsedParams = evalDatasetParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const run = await dependencies.evalLabService.runDataset(workspaceId, parsedParams.data.datasetId, {
        ...req.body,
        createdByAccountId: accountId ?? null,
      });
      res.status(201).json(run);
    } catch (error) {
      next(error);
    }
  });

  router.get("/datasets/:datasetId/runs/:runId", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedParams = evalRunParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const run = await dependencies.evalLabService.getRun(
        workspaceId,
        parsedParams.data.datasetId,
        parsedParams.data.runId,
      );
      res.status(200).json(run);
    } catch (error) {
      next(error);
    }
  });

  router.get("/datasets/:datasetId/runs/:runId/comparison", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedParams = evalRunParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const parsedQuery = evalComparisonQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const comparison = await dependencies.evalLabService.compareRun(
        workspaceId,
        parsedParams.data.datasetId,
        parsedParams.data.runId,
        parsedQuery.data.baselineRunId,
      );
      res.status(200).json(comparison);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
