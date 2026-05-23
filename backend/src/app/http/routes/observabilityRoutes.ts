import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { createRateLimitMiddleware } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";

const frontendProductAnalyticsSchema = z.object({
  eventName: z.literal("frontend.page_view"),
  properties: z.object({
    path: z.string().min(1).max(2048),
  }).strict(),
  source: z.enum(["frontend", "embed"]).default("frontend"),
}).strict();

const sanitizeFrontendPageViewPath = (rawPath: string): string => {
  let pathname = rawPath.trim();
  try {
    pathname = new URL(pathname).pathname;
  } catch {
    pathname = pathname.split(/[?#]/u)[0] ?? "";
  }

  const normalizedPathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return normalizedPathname
    .replace(/^\/invite\/[^/]+/u, "/invite/[token]")
    .replace(/^\/chat\/[^/]+/u, "/chat/[token]")
    .replace(/^\/embed\/[^/]+/u, "/embed/[token]")
    .replace(/^\/account\/[^/]+/u, "/account/[accountId]")
    .replace(/^\/w\/[^/]+/u, "/w/[workspaceKey]")
    .slice(0, 256);
};

export const createObservabilityRoutes = (
  dependencies: Pick<AppDependencies, "abuseControlService" | "auditService" | "productAnalyticsService">,
): Router => {
  const router = Router();
  const frontendProductAnalyticsRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "observability.product_analytics",
    limit: 240,
    windowMs: 60_000,
    blockMs: 60_000,
    resolveSubjectKey: (req) => String(req.ip ?? "unknown"),
  });

  router.post(
    "/product-analytics",
    frontendProductAnalyticsRateLimit,
    validateBody(frontendProductAnalyticsSchema),
    async (req, res, next) => {
      try {
        const event = await dependencies.productAnalyticsService.track({
          eventName: req.body.eventName,
          properties: {
            path: sanitizeFrontendPageViewPath(req.body.properties.path),
          },
          source: req.body.source,
        });
        res.status(202).json({ accepted: Boolean(event) });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
