import type { NextFunction, Request, RequestHandler, Response } from "express";

import { AppError, unauthorized } from "../../../shared/domain/errors.js";
import type { AppDependencies } from "../../server/types.js";

const WORKSPACE_HEADER = "x-workspace-id";
const BEARER_PREFIX = "Bearer ";

export const requireWorkspaceSession = (dependencies: AppDependencies): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionToken = req.cookies?.[dependencies.env.SESSION_COOKIE_NAME];
      if (sessionToken) {
        try {
          const session = await dependencies.authService.authenticateSession(sessionToken);
          const resolved = await dependencies.workspaceSessionService.resolve({
            accountId: session.accountId,
            workspaceId: req.header(WORKSPACE_HEADER),
          });
          res.locals.accountId = resolved.accountId;
          res.locals.workspaceId = resolved.workspaceId;
          res.locals.sessionId = session.sessionId;
          res.locals.authMode = "session";
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
      res.locals.workspaceId = auth.workspaceId;
      res.locals.authMode = "bearer";
      next();
    } catch (error) {
      next(error);
    }
  };
};
