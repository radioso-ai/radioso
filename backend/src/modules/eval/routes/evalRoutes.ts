import { Router } from "express";
import { z } from "zod";

import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../../../app/http/middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../../../app/http/middleware/requirePermission.js";
import { validateBody } from "../../../app/http/middleware/validate.js";
import type { EvalCaseService } from "../services/evalCaseService.js";
import type { EvalRunService } from "../services/evalRunService.js";
import type { EvalSuiteService } from "../services/evalSuiteService.js";
import type { EvalSnapshotService } from "../services/evalSnapshotService.js";
import type { EvalMessageCaseService } from "../services/evalMessageCaseService.js";
import type { InternalAgentConfig } from "../../agents/public.js";
import { badRequest, forbidden } from "../../../shared/domain/errors.js";
import { summarizeSuite } from "../domain/suite.js";
import { evalAssertionSchema } from "../domain/assertionSchema.js";
import { workbenchReplayRateLimiter, type WorkbenchReplayRateLimitDependencies } from "./workbenchReplayRateLimit.js";
import type { AppLogger } from "../../../shared/observability/logger.js";

const captureSnapshotSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid().optional(),
});

const assertionsSchema = z.array(evalAssertionSchema).max(20);

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
    // Seeds a starting routine position for a full_assistant replay (mid-routine resume).
    // The full RoutineState minus sessionId; the replay injects the conversation id.
    routineStartState: z
      .object({
        routineId: z.string().min(1).max(200),
        path: z.array(z.string().min(1).max(200)).min(1).max(200),
        variables: z.record(z.string(), z.unknown()),
        attempts: z.record(z.string(), z.number().int()).optional(),
        status: z.enum(["active", "suspended", "completed", "expired"]),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional(),
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

const executionModeSchema = z.object({
  executionMode: z.enum(["safe_test", "live"]),
});

const caseRunSchema = z.object({
  mode: z.enum(["retrieval_only", "full_assistant"]).default("full_assistant"),
  overrides: overridesSchema.optional(),
  allowLiveEffects: z.boolean().optional().default(false),
});

const batchRunSchema = z.object({
  mode: z.enum(["retrieval_only", "full_assistant"]).default("full_assistant"),
  // Optional subset to run (cost control). Omit to run the whole workspace.
  caseIds: z.array(z.string().uuid()).min(1).max(500).optional(),
  allowLiveEffects: z.boolean().optional().default(false),
});

/** Only an interactive workspace session may authorize a real external effect for this run. */
const confirmedLiveEffects = (res: { locals: { authMode?: string } }, requested: boolean): boolean => {
  if (!requested) return false;
  if (res.locals.authMode !== "session") {
    throw forbidden("Live Eval effects require an authenticated interactive workspace session");
  }
  return true;
};

const evalCaseParamsSchema = z.object({ id: z.string().uuid() });
const evalSnapshotParamsSchema = z.object({ id: z.string().uuid() });
const evalSourceMessageParamsSchema = z.object({ assistantMessageId: z.string().uuid() });

const parseRouteParams = <T extends z.ZodType>(
  schema: T,
  params: unknown,
  message: string,
): z.output<T> => {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw badRequest(message, result.error.flatten());
  }
  return result.data;
};

const oneOffRunSchema = z.object({
  snapshotId: z.string().uuid(),
  mode: z.enum(["retrieval_only", "full_assistant"]).default("full_assistant"),
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
  suggestions: result.run.observedOutput.suggestions,
  groundingVerdict: result.run.observedOutput.groundingVerdict,
  groundingDiagnostics: result.run.observedOutput.groundingDiagnostics,
  turnTrace: result.run.observedOutput.turnTrace,
  resolvedConfig: {
    ...result.run.resolvedConfig,
    retrievedChunks: result.run.observedOutput.retrievedChunks,
  },
});

export interface EvalRouteDependencies extends WorkspaceSessionDependencies {
  snapshotService: EvalSnapshotService;
  messageCaseService: EvalMessageCaseService;
  caseService: EvalCaseService;
  runService: EvalRunService;
  suiteService: EvalSuiteService;
  abuseControlService: WorkbenchReplayRateLimitDependencies["abuseControlService"];
  auditService: WorkbenchReplayRateLimitDependencies["auditService"];
  logger: Pick<AppLogger, "warn">;
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
        const { id: snapshotId } = parseRouteParams(
          evalSnapshotParamsSchema,
          req.params,
          "Invalid snapshot id",
        );
        const { workspaceId } = res.locals as { workspaceId: string };
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

  router.get(
    "/cases/by-source-message/:assistantMessageId",
    workspaceSession,
    requireQuery,
    async (req, res, next) => {
      try {
        const params = parseRouteParams(
          evalSourceMessageParamsSchema,
          req.params,
          "Invalid assistant message id",
        );
        const { workspaceId } = res.locals as { workspaceId: string };
        const association = await dependencies.messageCaseService.get(
          workspaceId,
          params.assistantMessageId,
        );
        res.status(200).json(association);
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/cases/by-source-message/:assistantMessageId",
    workspaceSession,
    requireQuery,
    async (req, res, next) => {
      try {
        const params = parseRouteParams(
          evalSourceMessageParamsSchema,
          req.params,
          "Invalid assistant message id",
        );
        const { workspaceId, userId } = res.locals as {
          workspaceId: string;
          userId?: string | null;
        };
        const association = await dependencies.messageCaseService.findOrCreate({
          workspaceId,
          assistantMessageId: params.assistantMessageId,
          createdBy: userId ?? null,
        });
        res.status(association.created ? 201 : 200).json(association);
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
        const { id: caseId } = parseRouteParams(evalCaseParamsSchema, req.params, "Invalid case id");
        const { workspaceId } = res.locals as { workspaceId: string };
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
        const { id: caseId } = parseRouteParams(evalCaseParamsSchema, req.params, "Invalid case id");
        const { workspaceId } = res.locals as { workspaceId: string };
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

  router.put(
    "/cases/:id/execution-mode",
    workspaceSession,
    requireQuery,
    validateBody(executionModeSchema),
    async (req, res, next) => {
      try {
        const { id: caseId } = parseRouteParams(evalCaseParamsSchema, req.params, "Invalid case id");
        const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string | null };
        const updated = await dependencies.caseService.setExecutionMode(
          workspaceId,
          caseId,
          req.body.executionMode,
        );
        try {
          await dependencies.auditService.record({
            accountId: accountId ?? null,
            workspaceId,
            eventType: "eval.case.execution_mode.updated",
            eventStatus: "success",
            metadata: { caseId, executionMode: updated.executionMode },
          });
        } catch (error) {
          dependencies.logger.warn(
            { err: error, workspaceId, caseId, executionMode: updated.executionMode },
            "Failed to audit Eval case execution-mode update",
          );
        }
        res.status(200).json(updated);
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete("/cases/:id", workspaceSession, requireQuery, async (req, res, next) => {
    try {
      const { id: caseId } = parseRouteParams(evalCaseParamsSchema, req.params, "Invalid case id");
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
      await dependencies.caseService.delete(workspaceId, caseId);
      await dependencies.auditService.record({
        accountId: accountId ?? null,
        workspaceId,
        eventType: "eval.case.delete",
        eventStatus: "success",
        metadata: { caseId },
      });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get("/cases", workspaceSession, requireQuery, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const cases = await dependencies.caseService.listWithLatestRun(workspaceId);
      res.status(200).json({ cases, summary: summarizeSuite(cases) });
    } catch (error) {
      next(error);
    }
  });

  // Run a batch of cases — the whole workspace, or a selected subset via
  // `caseIds` (cost control) — and return per-case outcomes plus the workspace's
  // aggregate pass rate. Cases without expectations are skipped (nothing to
  // score). Runs sequentially server-side, so this responds once all cases finish.
  router.post(
    "/cases/run",
    workspaceSession,
    requireQuery,
    validateBody(batchRunSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
        const result = await dependencies.suiteService.run({
          workspaceId,
          accountId: accountId ?? null,
          mode: req.body.mode,
          caseIds: req.body.caseIds,
          allowLiveEffects: confirmedLiveEffects(res, req.body.allowLiveEffects),
        });
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/cases/:id", workspaceSession, requireQuery, async (req, res, next) => {
    try {
      const { id: caseId } = parseRouteParams(evalCaseParamsSchema, req.params, "Invalid case id");
      const { workspaceId } = res.locals as { workspaceId: string };
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
    rateLimitWorkbenchReplay,
    async (req, res, next) => {
      try {
        const { id: caseId } = parseRouteParams(evalCaseParamsSchema, req.params, "Invalid case id");
        const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
        const evalCase = await dependencies.caseService.getWithRuns(workspaceId, caseId);
        const allowLiveEffects = confirmedLiveEffects(res, req.body.allowLiveEffects);
        // A routine start state is a workbench-replay override too: it only takes effect
        // through the conversation-engine replay path, never the plain retrieval runner.
        const wantsWorkbenchReplay = Boolean(
          req.body.overrides?.agentConfigOverride || req.body.overrides?.routineStartState,
        );
        if (req.body.mode === "full_assistant" && wantsWorkbenchReplay) {
          const result = await dependencies.runService.executeWorkbenchReplay({
            workspaceId,
            accountId: accountId ?? null,
            snapshotId: evalCase.snapshotId,
            caseId: evalCase.id,
            mode: req.body.mode,
            overrides: req.body.overrides,
            allowLiveEffects,
          });
          res.status(201).json(result);
          return;
        }
        const result = await dependencies.runService.execute({
          workspaceId,
          accountId: accountId ?? null,
          snapshotId: evalCase.snapshotId,
          caseId: evalCase.id,
          mode: req.body.mode,
          overrides: req.body.overrides,
          allowLiveEffects,
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
        // Either override routes through the conversation-engine replay path; a routine
        // start state never takes effect through the plain retrieval runner.
        const wantsWorkbenchReplay = Boolean(agentConfigOverride || req.body.overrides?.routineStartState);
        if (wantsWorkbenchReplay && req.body.mode !== "full_assistant") {
          throw badRequest("agentConfigOverride and routineStartState require full_assistant mode");
        }
        if (wantsWorkbenchReplay) {
          const result = await dependencies.runService.executeWorkbenchReplay({
            workspaceId,
            accountId: accountId ?? null,
            snapshotId: req.body.snapshotId,
            mode: req.body.mode,
            overrides: {
              ...req.body.overrides,
              ...(agentConfigOverride ? { agentConfigOverride } : {}),
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
