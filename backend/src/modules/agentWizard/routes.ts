import { Router } from "express";
import { z } from "zod";

import { requireWorkspacePermission } from "../../app/http/middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../../app/http/middleware/requireWorkspaceSession.js";
import type { AppDependencies } from "../../app/server/types.js";
import { badRequest } from "../../shared/domain/errors.js";
import { AgentWizardError, type AgentWizardProgressEvent, type AgentWizardService } from "./service.js";

type RouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "abuseControlService" | "accountAccessService">;

const parseBody = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  throw badRequest("Invalid request body", parsed.error.flatten());
};

const httpUrlSchema = z.string().url().max(2048).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}, "URL must use http or https");

const analyzeWebsiteSchema = z.object({
  url: httpUrlSchema,
});

const createFromWizardSchema = z.object({
  websiteUrl: httpUrlSchema,
  name: z.string().trim().min(1).max(200),
  customInstruction: z.string().max(2000).default(""),
  greetingInstruction: z.string().max(200).default(""),
  chunkingStrategy: z.enum(["fixed_window", "structured_semantic"]).optional(),
  faviconUrl: httpUrlSchema.nullable().optional(),
  assistantDefaultLocale: z.string().max(35).nullable().optional(),
  privacyPolicyUrl: httpUrlSchema.nullable().optional(),
  contactEmail: z.string().max(320).nullable().optional(),
});

const ANALYSIS_RATE_LIMIT = {
  scope: "agent_wizard.analyze",
  limit: 5,
  windowMs: 3_600_000,
  blockMs: 60_000,
};

const CREATE_RATE_LIMIT = {
  scope: "agent_wizard.create",
  limit: 10,
  windowMs: 3_600_000,
  blockMs: 60_000,
};

const getAnalysisSubjectKey = (locals: Record<string, unknown>): string => {
  const workspaceId = typeof locals.workspaceId === "string" ? locals.workspaceId : "unknown";
  const userId = typeof locals.userId === "string" ? locals.userId : null;
  return userId ? `${workspaceId}:user:${userId}` : `${workspaceId}:api`;
};

const sendError = (res: import("express").Response, error: unknown) => {
  const statusCode = error instanceof AgentWizardError
    ? error.statusCode
    : typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
  const code = error instanceof AgentWizardError
    ? error.code
    : typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : "analysis_failed";
  const message = error instanceof Error
    ? error.message
    : typeof (error as { message?: unknown })?.message === "string"
      ? (error as { message: string }).message
      : "Website analysis failed";
  res.status(statusCode).json({ code, message });
};

const writeSseEvent = (
  res: import("express").Response,
  eventName: "progress" | "complete" | "error",
  payload: unknown,
) => {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const enforceAnalysisRateLimit = async (
  dependencies: RouteDependencies,
  locals: Record<string, unknown>,
) => {
  await dependencies.abuseControlService.enforce({
    scope: ANALYSIS_RATE_LIMIT.scope,
    subjectKey: getAnalysisSubjectKey(locals),
    limit: ANALYSIS_RATE_LIMIT.limit,
    windowMs: ANALYSIS_RATE_LIMIT.windowMs,
    blockMs: ANALYSIS_RATE_LIMIT.blockMs,
  });
};

const enforceCreateRateLimit = async (
  dependencies: RouteDependencies,
  locals: Record<string, unknown>,
) => {
  await dependencies.abuseControlService.enforce({
    scope: CREATE_RATE_LIMIT.scope,
    subjectKey: getAnalysisSubjectKey(locals),
    limit: CREATE_RATE_LIMIT.limit,
    windowMs: CREATE_RATE_LIMIT.windowMs,
    blockMs: CREATE_RATE_LIMIT.blockMs,
  });
};

export const createAgentWizardRoutes = (
  dependencies: RouteDependencies,
  service: AgentWizardService,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const agentManage = requireWorkspacePermission(dependencies, "workspace.agents.manage");

  router.post("/analyze-website", workspaceSession, agentManage, async (req, res, next) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.on("aborted", abort);
    res.on("close", () => {
      if (!res.writableEnded) abort();
    });
    try {
      const body = parseBody(analyzeWebsiteSchema, req.body);
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      await enforceAnalysisRateLimit(dependencies, res.locals);
      const result = await service.analyzeWebsite({
        url: body.url,
        workspaceId,
        accountId,
        signal: controller.signal,
        timeoutMs: 90_000,
      });
      res.status(200).json(result);
    } catch (error) {
      // Client may have already disconnected (close handler aborted us).
      // Don't try to write to a torn-down socket — that just adds noise to
      // logs and risks "write after end" errors.
      if (res.writableEnded || controller.signal.aborted) {
        return;
      }
      sendError(res, error);
    } finally {
      req.off("aborted", abort);
    }
  });

  router.post("/analyze-website/stream", workspaceSession, agentManage, async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    // Listen to both signals: req.aborted fires for clean fetch aborts,
    // res "close" fires when the underlying socket closes (tab close, fetch
    // cancel, proxy disconnect). Without the close handler, the
    // crawler/LLM work could keep running until the 90s server timeout
    // even though no client is listening.
    req.on("aborted", abort);
    res.on("close", () => {
      if (!res.writableEnded) abort();
    });
    try {
      const body = parseBody(analyzeWebsiteSchema, req.body);
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      await enforceAnalysisRateLimit(dependencies, res.locals);

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const onProgress = (event: AgentWizardProgressEvent) => {
        writeSseEvent(res, "progress", event);
      };

      const result = await service.analyzeWebsite({
        url: body.url,
        workspaceId,
        accountId,
        signal: controller.signal,
        timeoutMs: 90_000,
        onProgress,
      });
      writeSseEvent(res, "complete", result);
      res.end();
    } catch (error) {
      if (!res.headersSent) {
        sendError(res, error);
        return;
      }
      const statusCode = error instanceof AgentWizardError ? error.statusCode : 500;
      const code = error instanceof AgentWizardError ? error.code : "analysis_failed";
      const message = error instanceof Error ? error.message : "Website analysis failed";
      writeSseEvent(res, "error", { code, message, statusCode });
      res.end();
    } finally {
      req.off("aborted", abort);
    }
  });

  router.post("/create", workspaceSession, agentManage, async (req, res, next) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.on("aborted", abort);
    res.on("close", () => {
      if (!res.writableEnded) abort();
    });
    try {
      const body = parseBody(createFromWizardSchema, req.body);
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      await enforceCreateRateLimit(dependencies, res.locals);
      const result = await service.createAgentFromWizard({
        workspaceId,
        accountId,
        config: body,
        signal: controller.signal,
      });
      if (res.writableEnded || controller.signal.aborted) {
        return;
      }
      res.status(201).json(result);
    } catch (error) {
      if (res.writableEnded || controller.signal.aborted) {
        return;
      }
      next(error);
    } finally {
      req.off("aborted", abort);
    }
  });

  return router;
};
