import type { NextFunction, Request, RequestHandler, Response } from "express";

import { AppError, unauthorized } from "../../../shared/domain/errors.js";
import type { Env } from "../../config/env.js";
import type { AccountAccessService } from "../../../modules/account/services/accountAccessService.js";
import type { AuthService } from "../../../modules/auth/services/authService.js";
import type { WorkspaceSessionService } from "../../../modules/auth/services/workspaceSessionService.js";

const WORKSPACE_HEADER = "x-workspace-id";
const BEARER_PREFIX = "Bearer ";

export interface WorkspaceSessionDependencies {
  env: Env;
  authService: AuthService;
  accountAccessService: AccountAccessService;
  workspaceSessionService: WorkspaceSessionService;
}

export const requireWorkspaceSession = (dependencies: WorkspaceSessionDependencies): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionToken = req.cookies?.[dependencies.env.SESSION_COOKIE_NAME];
      if (sessionToken) {
        try {
          const session = await dependencies.authService.authenticateSession(sessionToken);
          await dependencies.accountAccessService.requireActiveMembership(session.accountId, session.userId);
          const resolved = await dependencies.workspaceSessionService.resolve({
            accountId: session.accountId,
            workspaceId: req.header(WORKSPACE_HEADER),
          });
          res.locals.userId = session.userId;
          res.locals.accountId = resolved.accountId;
          res.locals.workspaceId = resolved.workspaceId;
          res.locals.sessionId = session.sessionId;
          res.locals.authMode = "session";
          res.locals.authPrincipal = {
            type: "session_user",
            userId: session.userId,
          };
          next();
          return;
        } catch (error) {
          if (!(error instanceof AppError) || error.statusCode !== 401) {
            throw error;
          }
        }
      }

      const authorization = req.header("authorization");
      const bearerToken =
        typeof authorization === "string" && authorization.startsWith(BEARER_PREFIX)
          ? authorization.slice(BEARER_PREFIX.length).trim()
          : null;

      if (!bearerToken) {
        next(unauthorized());
        return;
      }

      const auth = await dependencies.authService.authenticateApiToken(bearerToken);
      res.locals.accountId = auth.accountId;
      res.locals.bearerToken = bearerToken;
      res.locals.workspaceId = auth.workspaceId;
      res.locals.authMode = "bearer";
      res.locals.authPrincipal = auth.principal;
      next();
    } catch (error) {
      next(error);
    }
  };
};
