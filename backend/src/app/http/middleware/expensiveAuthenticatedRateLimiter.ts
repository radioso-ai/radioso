import { createHash } from "node:crypto";
import type { RequestHandler } from "express";

import type { AuthenticatedPrincipal } from "../../../modules/account/services/accountAccessService.js";
import type { Env } from "../../config/env.js";
import {
  createRateLimitMiddleware,
  type RateLimitAbuseControlPort,
  type RateLimitAuditPort,
} from "./rateLimit.js";

export interface ExpensiveAuthenticatedRateLimiterDependencies {
  env: Pick<Env,
    | "EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS"
    | "EXPENSIVE_AUTHENTICATED_RATE_LIMIT_WINDOW_MS"
  >;
  abuseControlService: RateLimitAbuseControlPort;
  auditService: RateLimitAuditPort;
}

const SCOPE = "api.expensive_authenticated";

const hashRateLimitPart = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);

const resolvePrincipalPart = (locals: {
  authPrincipal?: AuthenticatedPrincipal;
  bearerToken?: string;
}): string => {
  if (locals.authPrincipal?.type === "workspace_api_token") {
    if (locals.authPrincipal.tokenId) {
      return `api-token:${locals.authPrincipal.tokenId}`;
    }

    if (locals.bearerToken) {
      return `api-token-hash:${hashRateLimitPart(locals.bearerToken)}`;
    }

    return "api-token:unknown";
  }

  return "account";
};

export const expensiveAuthenticatedRateLimiter = (
  dependencies: ExpensiveAuthenticatedRateLimiterDependencies,
): RequestHandler =>
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: SCOPE,
    limit: dependencies.env.EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.EXPENSIVE_AUTHENTICATED_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (_req, res) => {
      const locals = res.locals as {
        accountId?: string;
        workspaceId?: string;
        authPrincipal?: AuthenticatedPrincipal;
        bearerToken?: string;
      };
      if (!locals.accountId || !locals.workspaceId) {
        return null;
      }

      return `account:${locals.accountId}:workspace:${locals.workspaceId}:${resolvePrincipalPart(locals)}`;
    },
    resolveAuditContext: (req, res) => {
      const locals = res.locals as {
        accountId?: string;
        authMode?: string;
        authPrincipal?: AuthenticatedPrincipal;
        workspaceId?: string;
      };
      return {
        accountId: locals.accountId ?? null,
        workspaceId: locals.workspaceId ?? null,
        metadata: {
          authMode: locals.authMode,
          principalType: locals.authPrincipal?.type,
          route: `${req.baseUrl}${req.path}`,
        },
      };
    },
  });
