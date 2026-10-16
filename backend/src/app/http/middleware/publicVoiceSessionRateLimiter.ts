import type { RequestHandler } from "express";

import type { Env } from "../../config/env.js";
import { notFound } from "../../../shared/domain/errors.js";
import { readRequestSource } from "./requestSource.js";
import { createRateLimitBatchMiddleware, type RateLimitAuditPort, type RateLimitBatchAbuseControlPort } from "./rateLimit.js";

export interface PublicVoiceSessionRateLimiterDependencies {
  env: Pick<Env,
    | "PUBLIC_VOICE_SESSION_START_RATE_LIMIT_MAX_ATTEMPTS"
    | "PUBLIC_VOICE_SESSION_START_RATE_LIMIT_WINDOW_MS"
    | "PUBLIC_VOICE_SESSION_START_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS"
    | "PUBLIC_VOICE_SESSION_START_WORKSPACE_RATE_LIMIT_WINDOW_MS"
  >;
  abuseControlService: RateLimitBatchAbuseControlPort;
  auditService: RateLimitAuditPort;
}

interface VoiceStartSubject {
  workspaceId: string;
  publicSessionId: string;
  sourceDigest: string;
}

const subjectOf = (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]): VoiceStartSubject | null => {
  const workspaceId = res.locals.workspaceId as string | undefined;
  const publicSessionId = res.locals.chatSessionId as string | undefined;
  const sourceDigest = readRequestSource(req, res).digest;
  return workspaceId && publicSessionId && sourceDigest ? { workspaceId, publicSessionId, sourceDigest } : null;
};

/**
 * Spends a voice session start's two budgets in one consumption, before the vendor is called: the
 * visitor's and the workspace's. The visitor budget is keyed on the signed public session id
 * together with the request source, never on the rate-limit cookie, which the public session check
 * mints afresh for a caller that sends none. Runs after that check; a request it left without a
 * session or a source is refused rather than let through unlimited.
 */
export const publicVoiceSessionStartRateLimiter = (dependencies: PublicVoiceSessionRateLimiterDependencies): RequestHandler[] => [
  (req, res, next) => {
    next(subjectOf(req, res) ? undefined : notFound("Not found"));
  },
  createRateLimitBatchMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    resolvePolicies: (req, res) => {
      const subject = subjectOf(req, res);
      if (!subject) return [];
      return [
        {
          scope: "public.voice.session_start",
          subjectKey: `${subject.workspaceId}:session:${subject.publicSessionId}:source:${subject.sourceDigest}`,
          limit: dependencies.env.PUBLIC_VOICE_SESSION_START_RATE_LIMIT_MAX_ATTEMPTS,
          windowMs: dependencies.env.PUBLIC_VOICE_SESSION_START_RATE_LIMIT_WINDOW_MS,
        },
        {
          scope: "public.voice.session_start.workspace",
          subjectKey: `${subject.workspaceId}:global`,
          limit: dependencies.env.PUBLIC_VOICE_SESSION_START_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS,
          windowMs: dependencies.env.PUBLIC_VOICE_SESSION_START_WORKSPACE_RATE_LIMIT_WINDOW_MS,
        },
      ];
    },
    resolveAuditContext: (_req, res) => ({ workspaceId: res.locals.workspaceId as string | undefined }),
  }),
];
