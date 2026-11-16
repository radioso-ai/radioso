import { createHash } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

import type { Env } from "../../config/env.js";
import { readRequestSource } from "./requestSource.js";
import {
  createRateLimitBatchMiddleware,
  createRateLimitMiddleware,
  type RateLimitAbuseControlPort,
  type RateLimitAuditPort,
  type RateLimitBatchAbuseControlPort,
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
    | "PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS"
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

/** Turn creation spends its budgets in one consumption. */
export interface PublicChatTurnRateLimiterDependencies extends Omit<AnonymousRateLimiterDependencies, "abuseControlService"> {
  abuseControlService: RateLimitBatchAbuseControlPort;
}

const hashRateLimitPart = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

/**
 * Whose budget a visitor's own messages and reads spend, within a workspace. A browser that keeps
 * the signed rate-limit cookie is one visitor across every session its tabs open. The website
 * embed runs in a cross-site frame, where browsers withhold that cookie, so a request without it
 * is known by its signed public session: the server minted the id, and a session is only had
 * through the session exchange, which is budgeted per launch link and request source. A request
 * with neither falls back to its request source.
 */
const visitorSubjectKey = (req: Request, res: Response): string | null => {
  const workspaceId = res.locals.workspaceId as string | undefined;
  if (!workspaceId) {
    return null;
  }

  const rateLimitId = res.locals.anonymousRateLimitId as string | undefined;
  if (rateLimitId && res.locals.anonymousRateLimitIdFromCookie === true) {
    return `${workspaceId}:browser:${rateLimitId}`;
  }

  const chatSessionId = res.locals.chatSessionId as string | undefined;
  if (chatSessionId) {
    return `${workspaceId}:session:${chatSessionId}`;
  }

  return `${workspaceId}:source:${readRequestSource(req, res).digest}`;
};

export const publicChatSessionExchangeRateLimiter = (dependencies: AnonymousRateLimiterDependencies): RequestHandler =>
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "public.chat.session.exchange",
    limit: dependencies.env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (req, res) => {
      const launchToken = typeof req.params.token === "string" ? req.params.token : "";
      if (!launchToken) {
        return null;
      }

      const channel = typeof req.body?.channel === "string" ? req.body.channel : "unknown";
      return `${hashRateLimitPart(launchToken)}:${channel}:source:${readRequestSource(req, res).digest}`;
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
    resolveSubjectKey: (req, res) => {
      const launchToken = typeof req.params.token === "string" ? req.params.token : "";
      if (!launchToken) {
        return null;
      }

      return `${hashRateLimitPart(launchToken)}:source:${readRequestSource(req, res).digest}`;
    },
    resolveAuditContext: (req) => ({
      metadata: {
        launchTokenHash: typeof req.params.token === "string" ? hashRateLimitPart(req.params.token) : undefined,
      },
    }),
  });

// A visitor session polls its own history, tail, and live-update connection far
// more often than it sends a message, so this gets its own, more generous
// budget on the same visitor key the turn-creation limiter below uses.
export const publicChatSessionReadRateLimiter = (dependencies: PublicChatSessionReadRateLimiterDependencies): RequestHandler =>
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "public.chat.session.read",
    limit: dependencies.env.PUBLIC_CHAT_SESSION_READ_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: visitorSubjectKey,
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

/**
 * Spends a visitor message's budgets in one consumption, so a message one budget refuses spends
 * none of the others.
 *
 * - The visitor's own (`public.chat.session`), keyed as `visitorSubjectKey` describes.
 * - The request source's (`public.chat.source`), shared by every visitor behind one address: a
 *   school, an office, a carrier NAT, or one script holding many cookies or sessions. Both the
 *   cookie and the session come free to whoever asks, so this is what bounds a caller that keeps
 *   minting them. It applies only where the request source names the visitor; behind a relay the
 *   backend cannot see past, every visitor shares the relay's address, and the budget would act as
 *   a second, smaller workspace cap.
 * - The workspace's (`public.chat.global`), across all of its visitors. Its size is the
 *   workspace's business, so the response headers describe only the visitor's own budgets, and a
 *   refusal by the workspace's says only when to retry.
 */
export const publicChatTurnRateLimiter = (dependencies: PublicChatTurnRateLimiterDependencies): RequestHandler =>
  createRateLimitBatchMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    resolvePolicies: (req, res) => {
      const workspaceId = res.locals.workspaceId as string | undefined;
      const visitorKey = visitorSubjectKey(req, res);
      if (!workspaceId || !visitorKey) {
        return [];
      }

      const { env } = dependencies;
      const windowMs = env.PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS;
      const source = readRequestSource(req, res);
      return [
        { scope: "public.chat.session", subjectKey: visitorKey, limit: env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS, windowMs },
        ...(source.identifiesClient
          ? [{
              scope: "public.chat.source",
              subjectKey: `${workspaceId}:source:${source.digest}`,
              limit: env.PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS,
              windowMs,
            }]
          : []),
        {
          scope: "public.chat.global",
          subjectKey: `${workspaceId}:global`,
          limit: env.PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS,
          windowMs,
          advertised: false,
        },
      ];
    },
    resolveAuditContext: (_req, res) => ({
      workspaceId: res.locals.workspaceId as string | undefined,
      metadata: {
        chatSessionId: res.locals.chatSessionId as string | undefined,
      },
    }),
  });

export const resetRateLimiterState = () => {
  // Durable abuse control state is reset by test repository setup, so this is now a no-op.
};
