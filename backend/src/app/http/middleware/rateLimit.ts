import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { AuditService } from "../../../modules/audit/contracts/index.js";

export interface RateLimitAbuseControlPort {
  enforce(input: {
    scope: string;
    subjectKey: string;
    limit: number;
    windowMs: number;
    blockMs?: number;
  }): Promise<unknown>;
}

interface CreateRateLimitMiddlewareInput {
  service: RateLimitAbuseControlPort;
  auditService: AuditService;
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
