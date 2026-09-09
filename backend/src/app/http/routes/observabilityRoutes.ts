import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { createRateLimitMiddleware } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";

const FRONTEND_ERROR_MESSAGE_MAX_LENGTH = 2048;
const FRONTEND_ERROR_STACK_MAX_LENGTH = 16_384;
const FRONTEND_ERROR_COMPONENT_STACK_MAX_LENGTH = 8192;
const FRONTEND_ERROR_CLASS_MAX_LENGTH = 256;
const FRONTEND_ERROR_PATH_MAX_LENGTH = 2048;

const truncate = (value: string, maxLength: number): string => value.slice(0, maxLength);

const frontendPageViewAnalyticsSchema = z.object({
  eventName: z.literal("frontend.page_view"),
  timestamp: z.string().datetime().optional(),
  properties: z.object({
    path: z.string().min(1).max(2048),
  }).strict(),
  source: z.enum(["frontend", "embed"]).default("frontend"),
}).strict();

const frontendCitationClickAnalyticsSchema = z.object({
  eventName: z.enum(["chat.citation_clicked", "chat.link_clicked"]),
  timestamp: z.string().datetime().optional(),
  subjectType: z.literal("conversation").optional(),
  subjectId: z.string().min(1).max(128).optional(),
  properties: z.object({
    surface: z.enum(["dashboard", "history", "eval", "public_chat", "embed"]),
    assistantMessageId: z.string().min(1).max(128).optional(),
    citationIndex: z.number().int().min(0).max(999).optional(),
    linkType: z.enum(["citation_marker", "source_chip", "citation_source_url", "assistant_url"]),
    documentId: z.string().min(1).max(128).optional(),
    chunkId: z.string().min(1).max(128).optional(),
    destinationOrigin: z.string().min(1).max(255).optional(),
    destinationPath: z.string().max(512).optional(),
  }).strict(),
  source: z.enum(["frontend", "embed"]).default("frontend"),
}).strict();

const frontendProductAnalyticsSchema = z.discriminatedUnion("eventName", [
  frontendPageViewAnalyticsSchema,
  frontendCitationClickAnalyticsSchema,
]);

const frontendErrorSchema = z.object({
  errorType: z.enum([
    "frontend.react.unhandled",
    "frontend.runtime.unhandled",
    "frontend.promise.unhandled",
  ]),
  timestamp: z.string().datetime().optional(),
  message: z.string().min(1).transform((value) => truncate(value, FRONTEND_ERROR_MESSAGE_MAX_LENGTH)),
  errorClass: z.string().min(1).transform((value) => truncate(value, FRONTEND_ERROR_CLASS_MAX_LENGTH)).optional(),
  stack: z.string().transform((value) => truncate(value, FRONTEND_ERROR_STACK_MAX_LENGTH)).optional(),
  componentStack: z.string().transform((value) => truncate(value, FRONTEND_ERROR_COMPONENT_STACK_MAX_LENGTH)).optional(),
  path: z.string().min(1).transform((value) => truncate(value, FRONTEND_ERROR_PATH_MAX_LENGTH)).optional(),
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

const removeUndefinedProperties = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

const sanitizeDestinationParts = (input: {
  destinationOrigin?: string;
  destinationPath?: string;
}): {
  destinationOrigin?: string;
  destinationPath?: string;
} => {
  if (!input.destinationOrigin) {
    return {};
  }

  try {
    const originUrl = input.destinationOrigin === "mailto:"
      ? null
      : new URL(input.destinationOrigin);
    const destinationOrigin = originUrl
      ? originUrl.origin.slice(0, 255)
      : "mailto:";
    const destinationPath = input.destinationPath
      ? input.destinationPath.split(/[?#]/u)[0]?.slice(0, 512) ?? ""
      : undefined;

    return removeUndefinedProperties({
      destinationOrigin,
      destinationPath,
    });
  } catch {
    return {};
  }
};

const BROWSER_EXTENSION_STACK_SCHEMES = [
  "chrome-extension",
  "moz-extension",
  "safari-web-extension",
];

// Mirrors the frontend report-time filter: when the topmost frame with a source
// URL comes from a browser extension (a crypto wallet or ad blocker fighting over
// globals such as `window.ethereum`), no Radioso code is on the stack. Reading the
// first `scheme://` skips engine frames such as `<anonymous>` that carry no URL, so
// the first URL belongs to the topmost frame with a real origin.
const STACK_FRAME_SCHEME_PATTERN = /([a-z][a-z0-9+.-]*):\/\//iu;

const topStackFrameUsesBrowserExtensionScheme = (stack: string | undefined): boolean => {
  const scheme = stack?.match(STACK_FRAME_SCHEME_PATTERN)?.[1]?.toLowerCase();
  return scheme !== undefined && BROWSER_EXTENSION_STACK_SCHEMES.includes(scheme);
};

const DROPPED_BROWSER_EXTENSION_ERROR_METRIC = "frontend_errors_dropped_browser_extension_total";
const DROPPED_BROWSER_EXTENSION_ERROR_METRIC_HELP =
  "Frontend error reports dropped because their top stack frame came from a browser extension.";

const sanitizeFrontendErrorStack = (stack: string | undefined): string | undefined => {
  if (!stack) {
    return undefined;
  }

  return stack
    .replace(/https?:\/\/[^\s)]+/gu, (rawUrl) => sanitizeFrontendPageViewPath(rawUrl))
    .replace(/[?#][^\s)]*/gu, "")
    .slice(0, 16_384);
};

export const createObservabilityRoutes = (
  dependencies: Pick<AppDependencies, "abuseControlService" | "auditService" | "errorReportingService" | "productAnalyticsService" | "metricsRegistry">,
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
  const frontendErrorRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "observability.frontend_errors",
    limit: 120,
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
        if (req.body.eventName === "chat.citation_clicked" || req.body.eventName === "chat.link_clicked") {
          const event = await dependencies.productAnalyticsService.track({
            eventName: req.body.eventName,
            subjectType: req.body.subjectType,
            subjectId: req.body.subjectId,
            properties: removeUndefinedProperties({
              surface: req.body.properties.surface,
              assistantMessageId: req.body.properties.assistantMessageId,
              citationIndex: req.body.properties.citationIndex,
              linkType: req.body.properties.linkType,
              documentId: req.body.properties.documentId,
              chunkId: req.body.properties.chunkId,
              ...sanitizeDestinationParts({
                destinationOrigin: req.body.properties.destinationOrigin,
                destinationPath: req.body.properties.destinationPath,
              }),
            }),
            source: req.body.source,
          });
          res.status(202).json({ accepted: Boolean(event) });
          return;
        }

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

  router.post(
    "/frontend-errors",
    frontendErrorRateLimit,
    validateBody(frontendErrorSchema),
    async (req, res, next) => {
      try {
        if (topStackFrameUsesBrowserExtensionScheme(req.body.stack)) {
          dependencies.metricsRegistry?.incrementCounter(DROPPED_BROWSER_EXTENSION_ERROR_METRIC, {
            help: DROPPED_BROWSER_EXTENSION_ERROR_METRIC_HELP,
          });
          res.status(202).json({ accepted: true, recorded: false });
          return;
        }

        const route = req.body.path ? sanitizeFrontendPageViewPath(req.body.path) : undefined;
        const event = await dependencies.errorReportingService.report({
          errorType: req.body.errorType,
          message: req.body.message,
          errorClass: req.body.errorClass,
          stack: sanitizeFrontendErrorStack(req.body.stack),
          requestContext: {
            method: "CLIENT",
            route,
          },
          metadata: {
            componentStack: req.body.componentStack,
            source: req.body.source,
            userAgent: String(req.headers["user-agent"] ?? "unknown").slice(0, 512),
          },
        });

        res.status(202).json({ accepted: true, recorded: Boolean(event) });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
