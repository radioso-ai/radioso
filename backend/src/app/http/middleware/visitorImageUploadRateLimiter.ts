import type { RequestHandler } from "express";

import type { AuthenticatedPrincipal } from "../../../modules/account/services/accountAccessService.js";
import { notFound } from "../../../shared/domain/errors.js";
import { readRequestSource } from "./requestSource.js";
import { createRateLimitBatchMiddleware, type RateLimitAuditPort, type RateLimitBatchAbuseControlPort } from "./rateLimit.js";

export interface VisitorImageUploadRateLimiterDependencies {
  abuseControlService: RateLimitBatchAbuseControlPort;
  auditService: RateLimitAuditPort;
}

/** One window for every budget: a photo upload costs a vision call, so the budgets are counted per ten minutes. */
const WINDOW_MS = 10 * 60 * 1_000;

/**
 * A visitor attaches at most three photos to a message; twenty per ten minutes from one session
 * and source leaves room to swap photos, and the source and workspace budgets stop a caller that
 * mints fresh sessions, and a workspace's total, from running up its model spend.
 */
const PUBLIC_BUDGETS = { sessionAndSource: 20, source: 40, workspace: 600 } as const;
/** An API credential sends photos for many end users, so its budget is wider; the workspace's matches the public one. */
const API_BUDGETS = { principal: 120, workspace: 600 } as const;

const publicSubjectOf = (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => {
  const workspaceId = res.locals.workspaceId as string | undefined;
  const publicSessionId = res.locals.chatSessionId as string | undefined;
  const sourceDigest = readRequestSource(req, res).digest;
  return workspaceId && publicSessionId && sourceDigest ? { workspaceId, publicSessionId, sourceDigest } : null;
};

/**
 * Spends a public photo upload's three budgets in one consumption, after the public session check
 * and before the agent is read or the body buffered: one on the signed public session with the
 * request source, one on the source alone, and the workspace's. A request with no session or
 * source is refused rather than let through unlimited.
 */
export const publicVisitorImageUploadRateLimiter = (dependencies: VisitorImageUploadRateLimiterDependencies): RequestHandler[] => [
  (req, res, next) => {
    next(publicSubjectOf(req, res) ? undefined : notFound("Not found"));
  },
  createRateLimitBatchMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    resolvePolicies: (req, res) => {
      const subject = publicSubjectOf(req, res);
      if (!subject) return [];
      return [
        {
          scope: "public.visitor_image.upload",
          subjectKey: `${subject.workspaceId}:session:${subject.publicSessionId}:source:${subject.sourceDigest}`,
          limit: PUBLIC_BUDGETS.sessionAndSource,
          windowMs: WINDOW_MS,
        },
        {
          scope: "public.visitor_image.upload.source",
          subjectKey: `${subject.workspaceId}:source:${subject.sourceDigest}`,
          limit: PUBLIC_BUDGETS.source,
          windowMs: WINDOW_MS,
        },
        {
          scope: "public.visitor_image.upload.workspace",
          subjectKey: `${subject.workspaceId}:global`,
          limit: PUBLIC_BUDGETS.workspace,
          windowMs: WINDOW_MS,
        },
      ];
    },
    resolveAuditContext: (_req, res) => ({ workspaceId: res.locals.workspaceId as string | undefined }),
  }),
];

/** The caller an API upload is counted against: its credential, the agent channel credential, or the signed-in user. */
const principalKeyOf = (locals: Record<string, unknown>): string | null => {
  const principal = locals.authPrincipal as AuthenticatedPrincipal | undefined;
  if (principal?.type === "personal_api_credential" || principal?.type === "service_account_credential") return `credential:${principal.credentialId}`;
  if (principal?.type === "session_user") return `user:${principal.userId}`;
  const grant = locals.agentChannelGrant as { id?: unknown } | undefined;
  return typeof grant?.id === "string" ? `credential:${grant.id}` : null;
};

/** An API photo upload's two budgets, per credential (or signed-in user) and per workspace, spent before the body is read. */
export const apiVisitorImageUploadRateLimiter = (dependencies: VisitorImageUploadRateLimiterDependencies): RequestHandler =>
  createRateLimitBatchMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    resolvePolicies: (_req, res) => {
      const workspaceId = res.locals.workspaceId as string | undefined;
      const principal = principalKeyOf(res.locals);
      if (!workspaceId || !principal) return [];
      return [
        { scope: "api.visitor_image.upload", subjectKey: `${workspaceId}:${principal}`, limit: API_BUDGETS.principal, windowMs: WINDOW_MS },
        { scope: "api.visitor_image.upload.workspace", subjectKey: `${workspaceId}:global`, limit: API_BUDGETS.workspace, windowMs: WINDOW_MS },
      ];
    },
    resolveAuditContext: (_req, res) => ({
      accountId: res.locals.accountId as string | undefined,
      workspaceId: res.locals.workspaceId as string | undefined,
    }),
  });
