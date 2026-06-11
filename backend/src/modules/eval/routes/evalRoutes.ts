import { Router } from "express";
import { z } from "zod";

import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../../../app/http/middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../../../app/http/middleware/requirePermission.js";
import { validateBody } from "../../../app/http/middleware/validate.js";
import type { EvalCaseService } from "../services/evalCaseService.js";
import type { EvalRunService } from "../services/evalRunService.js";
import type { EvalSnapshotService } from "../services/evalSnapshotService.js";
import type { InternalAgentConfig } from "../../agents/public.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { workbenchReplayRateLimiter, type WorkbenchReplayRateLimitDependencies } from "./workbenchReplayRateLimit.js";

const captureSnapshotSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid().optional(),
});

const answerMatchModeSchema = z.enum(["substring", "regex"]);

const answerAssertionFields = {
  pattern: z.string().min(1).max(4000),
  matchMode: answerMatchModeSchema,
  caseSensitive: z.boolean().optional(),
};

const assertionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("retrieval_includes_document"),
    documentId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("retrieval_excludes_document"),
    documentId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("retrieval_top_k_includes_document"),
    documentId: z.string().uuid(),
    k: z.number().int().min(1).max(100),
  }),
  z.object({
    type: z.literal("answer_contains"),
    ...answerAssertionFields,
  }),
  z.object({
    type: z.literal("answer_does_not_contain"),
    ...answerAssertionFields,
  }),
  z.object({
    type: z.literal("llm_judge"),
    expectedAnswer: z.string().min(1).max(8000),
    criteria: z.string().max(2000).optional(),
  }),
]);

const assertionsSchema = z.array(assertionSchema).max(20);

const overridesSchema = z
  .object({
    modelOverride: z
      .object({
        provider: z.enum(["openai", "openai-compatible", "gemini", "claude"]),
        model: z.string().min(1).max(200),
      })
      .optional(),
    assistantInstructionsOverride: z
      .object({
        customInstruction: z.string().max(4000).optional(),
      })
      .strict()
      .optional(),
    retrievalSettingsOverride: z
      .object({
        queryRewriteEnabled: z.boolean().optional(),
        suggestedQuestionsEnabled: z.boolean().optional(),
        suggestedQuestionsCount: z.number().int().optional(),
        rerankEnabled: z.boolean().optional(),
        vectorTopK: z.number().int().min(1).max(200).optional(),
        similarityThreshold: z.number().min(0).max(1).optional(),
        rerankTopK: z.number().int().min(1).max(50).optional(),
        customInstruction: z.string().max(4000).optional(),
      })
      .strict()
      .optional(),
    agentConfigOverride: z.lazy(() => agentConfigOverrideSchema).optional(),
  })
  .strict();

const agentConfigOverrideSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    customInstruction: z.string().max(4000).optional(),
    contactRequestsEnabled: z.boolean().optional(),
    webhookExportsEnabled: z.boolean().optional(),
    contactRequestDelivery: z.unknown().optional(),
    logo: z.unknown().nullable().optional(),
    theme: z.record(z.string(), z.unknown()).optional(),
    branding: z.record(z.string(), z.unknown()).optional(),
    greetingInstruction: z.string().max(4000).optional(),
    assistantDefaultLocale: z.string().max(64).nullable().optional(),
    proactiveGreetingEnabled: z.boolean().optional(),
    surfaceSettings: z.record(z.string(), z.unknown()).optional(),
    skillSettings: z.record(z.string(), z.unknown()).optional(),
    chatModelOverride: z
      .object({
        provider: z.enum(["openai", "openai-compatible", "gemini", "claude"]),
        model: z.string().min(1).max(200),
      })
      .nullable()
      .optional(),
    authoredDirectives: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

const createCaseSchema = z.object({
  snapshotId: z.string().uuid(),
  name: z.string().min(1).max(200),
  // Assertions are optional at creation — the user can configure them in
  // the eval editor after the case exists. Defaults to [].
  assertions: assertionsSchema.optional().default([]),
});

const renameCaseSchema = z.object({
  name: z.string().min(1).max(200),
});

const replaceAssertionsSchema = z.object({
  assertions: assertionsSchema,
});

const caseRunSchema = z.object({
  mode: z.enum(["retrieval_only", "full_assistant"]).default("retrieval_only"),
  overrides: overridesSchema.optional(),
});

const oneOffRunSchema = z.object({
  snapshotId: z.string().uuid(),
  mode: z.enum(["retrieval_only", "full_assistant"]).default("retrieval_only"),
  overrides: overridesSchema.optional(),
  agentConfigOverride: agentConfigOverrideSchema.optional(),
}).superRefine((input, ctx) => {
  if (input.agentConfigOverride && input.overrides?.agentConfigOverride) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide agentConfigOverride either at the top level or inside overrides, not both",
      path: ["agentConfigOverride"],
    });
  }
});

const presentWorkbenchReplayRun = (result: Awaited<ReturnType<EvalRunService["executeWorkbenchReplay"]>>) => ({
  ...result,
  answer: result.run.observedOutput.answer,
  citations: result.run.observedOutput.citations,
  answerSegments: result.run.observedOutput.answerSegments,
  turnTrace: result.run.observedOutput.turnTrace,
  resolvedConfig: {
    ...result.run.resolvedConfig,
    retrievedChunks: result.run.observedOutput.retrievedChunks,
  },
});

export interface EvalRouteDependencies extends WorkspaceSessionDependencies {
  snapshotService: EvalSnapshotService;
  caseService: EvalCaseService;
  runService: EvalRunService;
  abuseControlService: WorkbenchReplayRateLimitDependencies["abuseControlService"];
  auditService: WorkbenchReplayRateLimitDependencies["auditService"];
}

export const createEvalRoutes = (dependencies: EvalRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const requireQuery = requireWorkspacePermission(dependencies, "workspace.retrieval.query");
  const rateLimitWorkbenchReplay = workbenchReplayRateLimiter(dependencies);

  router.post(
    "/snapshots",
    workspaceSession,
    requireQuery,
    validateBody(captureSnapshotSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, userId } = res.locals as { workspaceId: string; userId?: string };
        const snapshot = await dependencies.snapshotService.capture({
          workspaceId,
          conversationId: req.body.conversationId,
          messageId: req.body.messageId ?? null,
          capturedBy: userId ?? null,
        });
        res.status(201).json(snapshot);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/snapshots/:id",
    workspaceSession,
    requireQuery,
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const snapshotId = String(req.params.id);
        const snapshot = await dependencies.snapshotService.getById(workspaceId, snapshotId);
        res.status(200).json(snapshot);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/cases",
    workspaceSession,
    requireQuery,
    validateBody(createCaseSchema),
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const created = await dependencies.caseService.create({
          workspaceId,
          snapshotId: req.body.snapshotId,
          name: req.body.name,
          assertions: req.body.assertions,
        });
        res.status(201).json(created);
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    "/cases/:id",
    workspaceSession,
    requireQuery,
    validateBody(renameCaseSchema),
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const caseId = String(req.params.id);
        const updated = await dependencies.caseService.rename(workspaceId, caseId, req.body.name);
        res.status(200).json(updated);
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/cases/:id/assertions",
    workspaceSession,
    requireQuery,
    validateBody(replaceAssertionsSchema),
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const caseId = String(req.params.id);
        const updated = await dependencies.caseService.replaceAssertions(
          workspaceId,
          caseId,
          req.body.assertions,
        );
        res.status(200).json(updated);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/cases", workspaceSession, requireQuery, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const cases = await dependencies.caseService.list(workspaceId);
      res.status(200).json({ cases });
    } catch (error) {
      next(error);
    }
  });

  router.get("/cases/:id", workspaceSession, requireQuery, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const caseId = String(req.params.id);
      const caseWithRuns = await dependencies.caseService.getWithRuns(workspaceId, caseId);
      res.status(200).json(caseWithRuns);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/cases/:id/runs",
    workspaceSession,
    requireQuery,
    validateBody(caseRunSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
        const caseId = String(req.params.id);
        const evalCase = await dependencies.caseService.getWithRuns(workspaceId, caseId);
        const result = await dependencies.runService.execute({
          workspaceId,
          accountId: accountId ?? null,
          snapshotId: evalCase.snapshotId,
          caseId: evalCase.id,
          mode: req.body.mode,
          overrides: req.body.overrides,
        });
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/runs",
    workspaceSession,
    requireQuery,
    validateBody(oneOffRunSchema),
    rateLimitWorkbenchReplay,
    async (req, res, next) => {
      try {
        const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
        const agentConfigOverride = (req.body.agentConfigOverride ?? req.body.overrides?.agentConfigOverride) as
          | Partial<InternalAgentConfig>
          | undefined;
        if (agentConfigOverride && req.body.mode !== "full_assistant") {
          throw badRequest("agentConfigOverride requires full_assistant mode");
        }
        if (agentConfigOverride) {
          const result = await dependencies.runService.executeWorkbenchReplay({
            workspaceId,
            accountId: accountId ?? null,
            snapshotId: req.body.snapshotId,
            mode: req.body.mode,
            overrides: {
              ...req.body.overrides,
              agentConfigOverride,
            },
          });
          res.status(201).json(presentWorkbenchReplayRun(result));
          return;
        }
        const result = await dependencies.runService.execute({
          workspaceId,
          accountId: accountId ?? null,
          snapshotId: req.body.snapshotId,
          mode: req.body.mode,
          overrides: req.body.overrides,
        });
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
