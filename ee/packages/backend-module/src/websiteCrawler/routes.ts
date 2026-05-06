import { Router, type RequestHandler } from "express";
import { z } from "zod";

import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import { resolveWebsiteCrawlerConfig } from "./config.js";
import {
  WebsiteCrawlerBadRequestError,
  WebsiteCrawlerUnavailableError,
} from "./errors.js";
import { EnterpriseWebsiteCrawlerService } from "./service.js";
import type { WebsiteCrawlerProvider } from "./provider.js";
import type { WebsiteCrawlerDocumentIngestionPort } from "./service.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0] & {
  websiteCrawlerProvider?: WebsiteCrawlerProvider;
  assertCrawlUrlAllowed?: (url: string) => Promise<void>;
};

export interface WebsiteCrawlerRouteOptions {
  provider?: WebsiteCrawlerProvider;
}

const CRAWL_RATE_LIMIT = 10;
const CRAWL_RATE_LIMIT_WINDOW_MS = 60_000;
const CRAWL_RATE_LIMIT_BLOCK_MS = 60_000;

const crawlBodySchema = z.object({
  url: z.string().trim().url().refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "URL must use http or https"),
  limit: z.number().int().positive().optional(),
});

const parseRequest = <T>(schema: z.ZodType<T>, value: unknown, message: string): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw new WebsiteCrawlerBadRequestError(message, parsed.error.flatten());
};

const BEARER_PREFIX = "Bearer ";

const requireCrawlerWorkspaceAuth = (dependencies: RouteDependencies): RequestHandler => async (req, res, next) => {
  try {
    const sessionToken = req.cookies?.[dependencies.env.SESSION_COOKIE_NAME];
    if (typeof sessionToken === "string" && sessionToken) {
      try {
        const session = await dependencies.authService.authenticateSession(sessionToken);
        await dependencies.accountAccessService.requireActiveMembership(session.accountId, session.userId);
        const workspace = await dependencies.workspaceSessionService.resolve({
          accountId: session.accountId,
          workspaceId: req.header("x-workspace-id"),
        });
        res.locals.accountId = workspace.accountId;
        res.locals.workspaceId = workspace.workspaceId;
        res.locals.userId = session.userId;
        res.locals.sessionId = session.sessionId;
        res.locals.authMode = "session";
        next();
        return;
      } catch (error) {
        if (!isUnauthorizedError(error)) {
          throw error;
        }
      }
    }

    const authorization = req.header("authorization");
    const bearerToken = typeof authorization === "string" && authorization.startsWith(BEARER_PREFIX)
      ? authorization.slice(BEARER_PREFIX.length).trim()
      : null;
    if (!bearerToken) {
      throw {
        statusCode: 401,
        code: "unauthorized",
        message: "Unauthorized",
      };
    }
    const auth = await dependencies.authService.authenticateApiToken(bearerToken);
    res.locals.accountId = auth.accountId;
    res.locals.workspaceId = auth.workspaceId;
    res.locals.authMode = "bearer";
    next();
  } catch (error) {
    next(error);
  }
};

const isUnauthorizedError = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === "object" &&
      "statusCode" in error &&
      (error as { statusCode?: unknown }).statusCode === 401,
  );

const enforceCrawlRateLimit = (dependencies: RouteDependencies): RequestHandler => async (_req, res, next) => {
  try {
    await dependencies.abuseControlService.enforce({
      scope: "ee.website_crawler.crawl",
      subjectKey: res.locals.authMode === "bearer"
        ? `${res.locals.workspaceId as string}:bearer`
        : `${res.locals.workspaceId as string}:user:${res.locals.userId as string}`,
      limit: CRAWL_RATE_LIMIT,
      windowMs: CRAWL_RATE_LIMIT_WINDOW_MS,
      blockMs: CRAWL_RATE_LIMIT_BLOCK_MS,
    });
    next();
  } catch (error) {
    next(error);
  }
};

export const createWebsiteCrawlerRoutes = (
  dependencies: RouteDependencies,
  options: WebsiteCrawlerRouteOptions = {},
): Router => {
  const router = Router();
  const configuredProvider = options.provider ?? dependencies.websiteCrawlerProvider ?? null;
  const documentIngestionService = dependencies.documentIngestionService as
    | WebsiteCrawlerDocumentIngestionPort
    | undefined;

  router.post("/crawl", requireCrawlerWorkspaceAuth(dependencies), enforceCrawlRateLimit(dependencies), async (req, res, next) => {
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
      if (!documentIngestionService) {
        throw new WebsiteCrawlerUnavailableError("Enterprise website crawler cannot access document ingestion");
      }

      const limit = Math.min(body.limit ?? config.defaultLimit, config.maxLimit);
      const service = new EnterpriseWebsiteCrawlerService({
        provider: configuredProvider,
        documentIngestionService,
        auditService: dependencies.auditService,
        assertCrawlUrlAllowed: dependencies.assertCrawlUrlAllowed,
      });
      const result = await service.crawlAndPublish({
        accountId: res.locals.accountId as string,
        workspaceId: res.locals.workspaceId as string,
        url: body.url,
        limit,
        signal: abortController.signal,
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
