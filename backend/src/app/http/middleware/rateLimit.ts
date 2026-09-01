import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface RateLimitAbuseControlPort {
  enforce(input: {
    scope: string;
    subjectKey: string;
    limit: number;
    windowMs: number;
    blockMs?: number;
  }): Promise<unknown>;
}

export interface RateLimitBatchAbuseControlPort {
  enforceBatch(inputs: readonly {
    scope: string;
    subjectKey: string;
    limit: number;
    windowMs: number;
    blockMs?: number;
  }[]): Promise<unknown>;
}

interface CreateRateLimitBatchMiddlewareInput {
  service: RateLimitBatchAbuseControlPort;
  auditService: RateLimitAuditPort;
  resolvePolicies: (req: Request, res: Response) => Array<{
    scope: string;
    subjectKey: string;
    limit: number;
    windowMs: number;
    blockMs?: number;
  }>;
  resolveAuditContext?: (req: Request, res: Response) => {
    accountId?: string | null;
    workspaceId?: string | null;
    metadata?: Record<string, unknown>;
  };
}

/** Applies related durable limits as one consumption so a rejected global cap cannot spend a grant cap. */
export const createRateLimitBatchMiddleware = (input: CreateRateLimitBatchMiddlewareInput): RequestHandler => {
  return async (req, res, next) => {
    const policies = input.resolvePolicies(req, res);
    if (policies.length === 0) {
      next();
      return;
    }
    try {
      await input.service.enforceBatch(policies);
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
            ...(auditContext?.metadata ?? {}),
          },
        }).catch(() => undefined);
      }
      next(error);
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
      await input.service.enforce({
        scope: input.scope,
        subjectKey,
        limit: typeof input.limit === "function" ? input.limit(req, res) : input.limit,
        windowMs: input.windowMs,
        blockMs: input.blockMs,
      });
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
      next(error);
    }
  };
};
