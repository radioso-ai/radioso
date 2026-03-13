import type { NextFunction, Request, RequestHandler, Response } from "express";

import { unauthorized } from "../../../shared/domain/errors.js";
import type { AppDependencies } from "../../server/types.js";

export const requireSession = (dependencies: AppDependencies): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionToken = req.cookies?.[dependencies.env.SESSION_COOKIE_NAME];

      if (!sessionToken) {
        next(unauthorized());
        return;
      }

      const session = await dependencies.authService.authenticateSession(sessionToken);
      res.locals.accountId = session.accountId;
      next();
    } catch (error) {
      next(error);
    }
  };
};
