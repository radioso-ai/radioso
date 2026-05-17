import { createHash } from "node:crypto";
import type { RequestHandler } from "express";

import type { AppDependencies } from "../../server/types.js";
import { createRateLimitMiddleware } from "./rateLimit.js";

export type AnonymousRateLimiterDependencies = Pick<AppDependencies, "env" | "abuseControlService" | "auditService">;

const hashRateLimitPart = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

const resolveRequestSource = (req: Parameters<Parameters<typeof createRateLimitMiddleware>[0]["resolveSubjectKey"]>[0]) =>
  req.ip || req.socket.remoteAddress || "unknown";

export const publicChatSessionExchangeRateLimiter = (dependencies: AnonymousRateLimiterDependencies): RequestHandler =>
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "public.chat.session.exchange",
    limit: dependencies.env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (req) => {
      const launchToken = typeof req.params.token === "string" ? req.params.token : "";
      if (!launchToken) {
        return null;
      }

      const channel = typeof req.body?.channel === "string" ? req.body.channel : "unknown";
      return `${hashRateLimitPart(launchToken)}:${channel}:source:${resolveRequestSource(req)}`;
    },
    resolveAuditContext: (req) => ({
      metadata: {
        channel: typeof req.body?.channel === "string" ? req.body.channel : undefined,
        launchTokenHash: typeof req.params.token === "string" ? hashRateLimitPart(req.params.token) : undefined,
      },
    }),
  });

export const anonymousRateLimiters = (dependencies: AnonymousRateLimiterDependencies): RequestHandler[] => [
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "public.chat.session",
    limit: dependencies.env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (req, res) => {
      const workspaceId = res.locals.workspaceId as string | undefined;
      if (!workspaceId) {
        return null;
      }

      const rateLimitId = res.locals.anonymousRateLimitId as string | undefined;
      if (rateLimitId && res.locals.anonymousRateLimitIdFromCookie === true) {
        return `${workspaceId}:browser:${rateLimitId}`;
      }

      const requestSource = resolveRequestSource(req);
      return `${workspaceId}:source:${requestSource}`;
    },
    resolveAuditContext: (_req, res) => ({
      workspaceId: res.locals.workspaceId as string | undefined,
      metadata: {
        anonymousSessionId: res.locals.anonymousSessionId as string | undefined,
      },
    }),
  }),
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "public.chat.global",
    limit: dependencies.env.PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (_req, res) => {
      const workspaceId = res.locals.workspaceId as string | undefined;
      return workspaceId ? `${workspaceId}:global` : null;
    },
    resolveAuditContext: (_req, res) => ({
      workspaceId: res.locals.workspaceId as string | undefined,
      metadata: {
        anonymousSessionId: res.locals.anonymousSessionId as string | undefined,
      },
    }),
  }),
];

export const resetRateLimiterState = () => {
  // Durable abuse control state is reset by test repository setup, so this is now a no-op.
};
