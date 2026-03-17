import type { NextFunction, Request, RequestHandler, Response } from "express";

import { unauthorized } from "../../../shared/domain/errors.js";
import type { AppDependencies } from "../../server/types.js";

export const requireApiToken = (dependencies: AppDependencies): RequestHandler => {
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
      next();
    } catch (error) {
      next(error);
    }
  };
};
