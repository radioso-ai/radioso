import { createHash } from "node:crypto";
import type { RequestHandler } from "express";

import type { Env } from "../../config/env.js";
import {
  createRateLimitMiddleware,
  type RateLimitAbuseControlPort,
  type RateLimitAuditPort,
} from "./rateLimit.js";

interface RateLimiterAbuseControlDependencies {
  abuseControlService: RateLimitAbuseControlPort;
  auditService: RateLimitAuditPort;
}

export interface AnonymousRateLimiterDependencies extends RateLimiterAbuseControlDependencies {
  env: Pick<Env,
    | "PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS"
    | "PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS"
    | "PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS"
  >;
}

// Shared by embed-config and feedback: both piggyback on the session-exchange budget and read
// nothing beyond it, unlike session-read below, which has its own, more generous env knob. Route
// modules that only ever call one of these two limiters (e.g. answerFeedbackRoutes.ts) depend on
// this staying narrow rather than pulling in every public-chat rate-limit env key.
interface PublicChatSessionBudgetRateLimiterDependencies extends RateLimiterAbuseControlDependencies {
  env: Pick<Env, "PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS" | "PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS">;
}

interface PublicChatSessionReadRateLimiterDependencies extends RateLimiterAbuseControlDependencies {
  env: Pick<Env, "PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS" | "PUBLIC_CHAT_SESSION_READ_RATE_LIMIT_MAX_ATTEMPTS">;
}

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

// Pre-session: no chat session exists yet, only the launch token in the URL, so
// this shares the session-exchange budget and key shape rather than the
// per-session budget below.
export const publicChatEmbedConfigRateLimiter = (dependencies: PublicChatSessionBudgetRateLimiterDependencies): RequestHandler =>
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "public.chat.embed_config",
    limit: dependencies.env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (req) => {
      const launchToken = typeof req.params.token === "string" ? req.params.token : "";
      if (!launchToken) {
        return null;
      }

      return `${hashRateLimitPart(launchToken)}:source:${resolveRequestSource(req)}`;
    },
    resolveAuditContext: (req) => ({
      metadata: {
        launchTokenHash: typeof req.params.token === "string" ? hashRateLimitPart(req.params.token) : undefined,
      },
    }),
  });

// A visitor session polls its own history, tail, and live-update connection far
// more often than it sends a message, so this gets its own, more generous
// budget on the same session/source key the turn-creation limiter below uses.
export const publicChatSessionReadRateLimiter = (dependencies: PublicChatSessionReadRateLimiterDependencies): RequestHandler =>
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "public.chat.session.read",
    limit: dependencies.env.PUBLIC_CHAT_SESSION_READ_RATE_LIMIT_MAX_ATTEMPTS,
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

      return `${workspaceId}:source:${resolveRequestSource(req)}`;
    },
    resolveAuditContext: (_req, res) => ({
      workspaceId: res.locals.workspaceId as string | undefined,
      metadata: {
        chatSessionId: res.locals.chatSessionId as string | undefined,
      },
    }),
  });

// A visitor rates or unrates a message far less often than it polls, so this
// reuses the session-exchange budget rather than the read or turn budgets.
export const publicChatFeedbackRateLimiter = (dependencies: PublicChatSessionBudgetRateLimiterDependencies): RequestHandler =>
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "public.chat.feedback",
    limit: dependencies.env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (_req, res) => {
      const workspaceId = res.locals.workspaceId as string | undefined;
      const anonymousSessionId = res.locals.anonymousSessionId as string | undefined;
      if (!workspaceId || !anonymousSessionId) {
        return null;
      }

      return `${workspaceId}:session:${anonymousSessionId}`;
    },
    resolveAuditContext: (_req, res) => ({
      workspaceId: res.locals.workspaceId as string | undefined,
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
        chatSessionId: res.locals.chatSessionId as string | undefined,
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
        chatSessionId: res.locals.chatSessionId as string | undefined,
      },
    }),
  }),
];

export const resetRateLimiterState = () => {
  // Durable abuse control state is reset by test repository setup, so this is now a no-op.
};
