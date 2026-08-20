import { Router, type RequestHandler } from "express";
import { z } from "zod";

import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../../app/http/middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../../app/http/middleware/requirePermission.js";
import {
  createRateLimitMiddleware,
  type RateLimitAbuseControlPort,
  type RateLimitAuditPort,
} from "../../app/http/middleware/rateLimit.js";
import { resolveWebsiteCrawlerConfig } from "./config.js";
import {
  WebsiteCrawlerBadRequestError,
  WebsiteCrawlerUnavailableError,
} from "./errors.js";
import type { WebsiteCrawlerProvider } from "./provider.js";
import type { WebsiteCrawlJobService } from "./jobService.js";

type RouteDependencies = WorkspaceSessionDependencies & {
  abuseControlService: RateLimitAbuseControlPort;
  auditService: RateLimitAuditPort;
  websiteCrawlJobService: WebsiteCrawlJobService;
  websiteCrawlerProvider?: WebsiteCrawlerProvider;
  assertCrawlUrlAllowed?: (url: string) => Promise<void>;
};

export interface WebsiteCrawlerRouteOptions {
  provider?: WebsiteCrawlerProvider;
}

const CRAWL_RATE_LIMIT = 10;
const CRAWL_RATE_LIMIT_WINDOW_MS = 60_000;
const CRAWL_RATE_LIMIT_BLOCK_MS = 60_000;
// The dashboard polls GET /jobs every 2s while jobs are non-terminal — about
// 30/min per tab. The bucket is keyed by workspace + actor, so multiple tabs
// (and admin/preview tabs) share it; 300/min comfortably accommodates a few
// concurrent tabs while still bounding the cost of a runaway client or a
// compromised workspace token.
const CRAWL_JOB_READ_RATE_LIMIT = 300;
const CRAWL_JOB_READ_RATE_LIMIT_WINDOW_MS = 60_000;

export const crawlBodySchema = z.object({
  url: z.string().trim().url().refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "URL must use http or https"),
  limit: z.number().int().positive().optional(),
  includeUrlPatterns: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  excludeUrlPatterns: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  preserveContentLinks: z.boolean().optional(),
});

const crawlJobsQuerySchema = z.object({
  status: z.enum(["queued", "processing", "paused", "completed", "failed"]).optional(),
  sinceMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  sourceId: z.string().uuid().optional(),
});

const crawlJobParamsSchema = z.object({
  jobId: z.string().uuid(),
});

const parseRequest = <T>(schema: z.ZodType<T>, value: unknown, message: string): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw new WebsiteCrawlerBadRequestError(message, parsed.error.flatten());
};

export const createWebsiteCrawlerRoutes = (
  dependencies: RouteDependencies,
  options: WebsiteCrawlerRouteOptions = {},
): Router => {
  const router = Router();
  const configuredProvider = options.provider ?? dependencies.websiteCrawlerProvider ?? null;

  const workspaceSession = requireWorkspaceSession(dependencies);
  const documentsRead = requireWorkspacePermission(dependencies, "workspace.documents.read");
  const documentsManage = requireWorkspacePermission(dependencies, "workspace.documents.manage");
  const resolveCrawlSubjectKey = (_req: unknown, res: { locals: Record<string, unknown> }) =>
    res.locals.authMode === "bearer"
      ? `${res.locals.workspaceId as string}:bearer`
      : `${res.locals.workspaceId as string}:user:${res.locals.userId as string}`;
  const resolveCrawlAuditContext = (_req: unknown, res: { locals: Record<string, unknown> }) => ({
    accountId: res.locals.accountId as string | undefined,
    workspaceId: res.locals.workspaceId as string | undefined,
  });
  const crawlRateLimit: RequestHandler = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "document.crawl",
    limit: CRAWL_RATE_LIMIT,
    windowMs: CRAWL_RATE_LIMIT_WINDOW_MS,
    blockMs: CRAWL_RATE_LIMIT_BLOCK_MS,
    resolveSubjectKey: resolveCrawlSubjectKey,
    resolveAuditContext: resolveCrawlAuditContext,
  });
  const crawlJobReadRateLimit: RequestHandler = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "document.crawl.jobs.read",
    limit: CRAWL_JOB_READ_RATE_LIMIT,
    windowMs: CRAWL_JOB_READ_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: resolveCrawlSubjectKey,
    resolveAuditContext: resolveCrawlAuditContext,
  });

  router.get("/jobs", workspaceSession, documentsRead, crawlJobReadRateLimit, async (req, res, next) => {
    try {
      const query = parseRequest(crawlJobsQuerySchema, req.query, "Invalid crawl jobs query");
      const useUnboundedWindow = query.status === "paused" || (Boolean(query.sourceId) && query.status === undefined);
      const jobs = await dependencies.websiteCrawlJobService.listForWorkspace(
        res.locals.workspaceId as string,
        {
          status: query.status,
          sinceMinutes: useUnboundedWindow ? undefined : (query.sinceMinutes ?? 30),
          limit: query.limit,
          sourceId: query.sourceId,
        },
      );
      res.status(200).json({ jobs });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/jobs/:jobId", workspaceSession, documentsManage, crawlJobReadRateLimit, async (req, res, next) => {
    try {
      const params = parseRequest(crawlJobParamsSchema, req.params, "Invalid crawl job id");
      await dependencies.websiteCrawlJobService.deleteJob({
        workspaceId: res.locals.workspaceId as string,
        jobId: params.jobId,
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/", workspaceSession, documentsManage, crawlRateLimit, async (req, res, next) => {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    const abortIfResponseDidNotFinish = () => {
      if (!res.writableEnded) {
        abort();
      }
    };
    req.on("aborted", abort);
    res.on("close", abortIfResponseDidNotFinish);
    try {
      const config = resolveWebsiteCrawlerConfig();
      const body = parseRequest(crawlBodySchema, req.body, "Invalid website crawl request");
      if (!configuredProvider) {
        throw new WebsiteCrawlerUnavailableError();
      }

      const limit = Math.min(body.limit ?? config.defaultLimit, config.maxLimit);
      const result = await dependencies.websiteCrawlJobService.enqueue({
        accountId: res.locals.accountId as string,
        workspaceId: res.locals.workspaceId as string,
        url: body.url,
        limit,
        policy: {
          includeUrlPatterns: body.includeUrlPatterns ?? [],
          excludeUrlPatterns: body.excludeUrlPatterns ?? [],
          preserveContentLinks: body.preserveContentLinks ?? true,
        },
      });
      res.status(202).json(result);
    } catch (error) {
      next(error);
    } finally {
      req.off("aborted", abort);
      res.off("close", abortIfResponseDidNotFinish);
    }
  });

  return router;
};
