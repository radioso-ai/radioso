import type { NextFunction, Request, RequestHandler, Response } from "express";

import { unauthorized } from "../../../shared/domain/errors.js";
import type { AuthService } from "../../../modules/auth/services/authService.js";

export interface ApiTokenDependencies {
  authService: Pick<AuthService, "authenticateApiToken">;
}

export const requireApiToken = (dependencies: ApiTokenDependencies): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authorization = req.header("authorization");

      if (!authorization?.startsWith("Bearer ")) {
        next(unauthorized());
        return;
      }

      const token = authorization.slice("Bearer ".length);
      const session = await dependencies.authService.authenticateApiToken(token);
      res.locals.workspaceId = session.workspaceId;
      res.locals.accountId = session.accountId;
      res.locals.authMode = "bearer";
      res.locals.authPrincipal = session.principal;
      next();
    } catch (error) {
      next(error);
    }
  };
};
