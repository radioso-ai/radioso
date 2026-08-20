import type { NextFunction, Request, RequestHandler, Response } from "express";

import { unauthorized } from "../../../shared/domain/errors.js";
import type { Env } from "../../config/env.js";
import type { AccountAccessService } from "../../../modules/account/services/accountAccessService.js";
import type { AuthService } from "../../../modules/auth/services/authService.js";

export interface SessionDependencies {
  env: Env;
  authService: AuthService;
  accountAccessService: AccountAccessService;
}

export const requireSession = (
  dependencies: SessionDependencies,
  options: { requireActiveMembership?: boolean } = {},
): RequestHandler => {
  const requireActiveMembership = options.requireActiveMembership ?? true;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionToken = req.cookies?.[dependencies.env.SESSION_COOKIE_NAME];

      if (!sessionToken) {
        next(unauthorized());
        return;
      }

      const session = await dependencies.authService.authenticateSession(sessionToken);
      if (requireActiveMembership) {
        await dependencies.accountAccessService.requireActiveMembership(session.accountId, session.userId);
      }
      res.locals.userId = session.userId;
      res.locals.accountId = session.accountId;
      res.locals.sessionId = session.sessionId;
      next();
    } catch (error) {
      next(error);
    }
  };
};
