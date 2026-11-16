import type { NextFunction, Request, RequestHandler, Response } from "express";

import { AbuseControlBatchRefusal, type AbuseControlDecision } from "../../../modules/security/contracts/abuseControl.js";
import { tooManyRequests } from "../../../shared/domain/errors.js";
import { applyRateLimitHeaders, applyRetryAfterFromError } from "../rateLimitHeaders.js";

export interface RateLimitAbuseControlPort {
  enforce(input: {
    scope: string;
    subjectKey: string;
    limit: number;
    windowMs: number;
    blockMs?: number;
  }): Promise<AbuseControlDecision>;
}

export interface RateLimitBatchAbuseControlPort {
  enforceBatch(inputs: readonly {
    scope: string;
    subjectKey: string;
    limit: number;
    windowMs: number;
    blockMs?: number;
  }[]): Promise<AbuseControlDecision[]>;
}

/**
 * The budget the caller is closest to spending is the one worth advertising. Between budgets
 * equally spent, the one that refills last, so the reset never names a time another still refuses.
 */
const tightest = (decisions: readonly AbuseControlDecision[]): AbuseControlDecision | null =>
  decisions.reduce<AbuseControlDecision | null>(
    (tightestSoFar, decision) =>
      tightestSoFar === null
        || decision.remaining < tightestSoFar.remaining
        || (decision.remaining === tightestSoFar.remaining && decision.resetAtMs > tightestSoFar.resetAtMs)
        ? decision
        : tightestSoFar,
    null,
  );

const applyBlockedHeaders = (res: Response, error: unknown): void => {
  if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number") {
    applyRetryAfterFromError(res, error as { statusCode: number; details?: unknown });
  }
};

interface RateLimitBatchPolicy {
  scope: string;
  subjectKey: string;
  limit: number;
  windowMs: number;
  blockMs?: number;
  /**
   * Whether the caller is told this budget's figures. Defaults to true. A budget shared beyond the
   * caller, such as a workspace's total, sets false: its size stays private, it never shapes the
   * `RateLimit-*` headers, and a refusal it raises says only when to retry.
   */
  advertised?: boolean;
}

interface CreateRateLimitBatchMiddlewareInput {
  service: RateLimitBatchAbuseControlPort;
  auditService: RateLimitAuditPort;
  resolvePolicies: (req: Request, res: Response) => RateLimitBatchPolicy[];
  resolveAuditContext?: (req: Request, res: Response) => {
    accountId?: string | null;
    workspaceId?: string | null;
    metadata?: Record<string, unknown>;
  };
}

const isAdvertised = (policy: RateLimitBatchPolicy): boolean => policy.advertised !== false;

/** Which budget refused, so the audit record says what the caller ran into. */
const refusalAuditFields = (error: unknown): Record<string, unknown> =>
  error instanceof AbuseControlBatchRefusal
    ? { ...error.refusedPolicy, limit: (error.details as AbuseControlDecision).limit }
    : {};

/**
 * A refusal by a budget the caller is not shown keeps its status and wait and drops the figures,
 * so neither the headers nor the body state the budget's size.
 */
const withoutUnadvertisedFigures = (error: unknown, policies: readonly RateLimitBatchPolicy[]): unknown => {
  if (!(error instanceof AbuseControlBatchRefusal)) {
    return error;
  }
  const { scope, subjectKey } = error.refusedPolicy;
  const policy = policies.find((candidate) => candidate.scope === scope && candidate.subjectKey === subjectKey);
  if (!policy || isAdvertised(policy)) {
    return error;
  }
  const { retryAfterSeconds } = error.details as AbuseControlDecision;
  return tooManyRequests(error.message, retryAfterSeconds === undefined ? undefined : { retryAfterSeconds });
};

/** Applies related durable limits as one consumption so a rejected global cap cannot spend a grant cap. */
export const createRateLimitBatchMiddleware = (input: CreateRateLimitBatchMiddlewareInput): RequestHandler => {
  return async (req, res, next) => {
    const policies = input.resolvePolicies(req, res);
    if (policies.length === 0) {
      next();
      return;
    }
    try {
      const decisions = await input.service.enforceBatch(policies.map(({ advertised: _advertised, ...policy }) => policy));
      const decision = tightest(decisions.filter((_decision, index) => isAdvertised(policies[index])));
      if (decision) {
        applyRateLimitHeaders(res, decision);
      }
      next();
    } catch (error) {
      const statusCode = error && typeof error === "object" && "statusCode" in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
      if (statusCode === 429 || statusCode === 503) {
        const auditContext = input.resolveAuditContext?.(req, res);
        void input.auditService.record({
          accountId: auditContext?.accountId ?? null,
          workspaceId: auditContext?.workspaceId ?? null,
          eventType: statusCode === 429 ? "security.rate_limit_enforced" : "security.rate_limit_unavailable",
          eventStatus: statusCode === 429 ? "success" : "failure",
          metadata: {
            scopes: policies.map((policy) => policy.scope),
            ...refusalAuditFields(error),
            ...(auditContext?.metadata ?? {}),
          },
        }).catch(() => undefined);
      }
      const callerFacingError = withoutUnadvertisedFigures(error, policies);
      applyBlockedHeaders(res, callerFacingError);
      next(callerFacingError);
    }
  };
};

export interface RateLimitAuditPort {
  record(input: {
    accountId?: string | null;
    workspaceId?: string | null;
    eventType: string;
    eventStatus: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

interface CreateRateLimitMiddlewareInput {
  service: RateLimitAbuseControlPort;
  auditService: RateLimitAuditPort;
  scope: string;
  limit: number | ((req: Request, res: Response) => number);
  windowMs: number;
  blockMs?: number;
  resolveSubjectKey: (req: Request, res: Response) => string | null | undefined;
  resolveAuditContext?: (req: Request, res: Response) => {
    accountId?: string | null;
    workspaceId?: string | null;
    metadata?: Record<string, unknown>;
  };
}

export const createRateLimitMiddleware = (input: CreateRateLimitMiddlewareInput): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const subjectKey = input.resolveSubjectKey(req, res);
    if (!subjectKey) {
      next();
      return;
    }

    try {
      applyRateLimitHeaders(res, await input.service.enforce({
        scope: input.scope,
        subjectKey,
        limit: typeof input.limit === "function" ? input.limit(req, res) : input.limit,
        windowMs: input.windowMs,
        blockMs: input.blockMs,
      }));
      next();
    } catch (error) {
      if (error && typeof error === "object" && "statusCode" in error && (error as { statusCode?: number }).statusCode === 429) {
        const auditContext = input.resolveAuditContext?.(req, res);
        void input.auditService.record({
          accountId: auditContext?.accountId ?? null,
          workspaceId: auditContext?.workspaceId ?? null,
          eventType: "security.rate_limit_enforced",
          eventStatus: "success",
          metadata: {
            scope: input.scope,
            subjectKey,
            ...(auditContext?.metadata ?? {}),
          },
        }).catch(() => undefined);
      }
      if (error && typeof error === "object" && "statusCode" in error && (error as { statusCode?: number }).statusCode === 503) {
        const auditContext = input.resolveAuditContext?.(req, res);
        void input.auditService.record({
          accountId: auditContext?.accountId ?? null,
          workspaceId: auditContext?.workspaceId ?? null,
          eventType: "security.rate_limit_unavailable",
          eventStatus: "failure",
          metadata: {
            scope: input.scope,
            subjectKey,
            ...(auditContext?.metadata ?? {}),
          },
        }).catch(() => undefined);
      }
      applyBlockedHeaders(res, error);
      next(error);
    }
  };
};
