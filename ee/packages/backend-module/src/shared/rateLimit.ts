import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Mirrors the OSS backend's abuse-control port (`RateLimitAbuseControlPort` in
 * backend/src/app/http/middleware/rateLimit.ts) structurally, the same way
 * `ApplicationRouteMount["createRouter"]`'s inline dependency types already do, so this
 * package enforces rate limits against the real abuse-control service without importing
 * OSS source across the workspace boundary.
 */
export interface RateLimitAbuseControlPort {
  enforce(input: {
    scope: string;
    subjectKey: string;
    limit: number;
    windowMs: number;
    blockMs?: number;
  }): Promise<unknown>;
}

interface RateLimitAuditPort {
  record(input: {
    accountId?: string | null;
    workspaceId?: string | null;
    eventType: string;
    eventStatus: "success" | "failure";
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

interface CreateRateLimitMiddlewareInput {
  service: RateLimitAbuseControlPort;
  auditService: RateLimitAuditPort;
  scope: string;
  limit: number;
  windowMs: number;
  resolveSubjectKey: (req: Request, res: Response) => string | null | undefined;
  resolveAuditMetadata?: (req: Request, res: Response) => Record<string, unknown>;
}

const statusCodeOf = (error: unknown): number | undefined =>
  error && typeof error === "object" && "statusCode" in error
    ? (error as { statusCode?: unknown }).statusCode as number | undefined
    : undefined;

/**
 * Enforces a durable abuse-control limit ahead of a route handler. A rejection is a thrown,
 * duck-typed HTTP error (`statusCode` 429 or 503) that the shared error handler already
 * understands, so this middleware only needs to record an audit event and forward it.
 */
export const createRateLimitMiddleware = (input: CreateRateLimitMiddlewareInput): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction) => {
    const subjectKey = input.resolveSubjectKey(req, res);
    if (!subjectKey) {
      next();
      return;
    }

    try {
      await input.service.enforce({
        scope: input.scope,
        subjectKey,
        limit: input.limit,
        windowMs: input.windowMs,
      });
      next();
    } catch (error) {
      const statusCode = statusCodeOf(error);
      if (statusCode === 429 || statusCode === 503) {
        void input.auditService.record({
          eventType: statusCode === 429 ? "security.rate_limit_enforced" : "security.rate_limit_unavailable",
          eventStatus: statusCode === 429 ? "success" : "failure",
          metadata: {
            scope: input.scope,
            subjectKey,
            ...(input.resolveAuditMetadata?.(req, res) ?? {}),
          },
        }).catch(() => undefined);
      }
      next(error);
    }
  };
