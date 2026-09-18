import type { RequestHandler } from "express";

import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import { HttpError } from "./httpError.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

/**
 * Session-cookie auth shared by every EE route mount that scopes to an account (usage limits,
 * billing). Extracted from `usageLimits/usageLimitRoutes.ts` so billing routes reuse the same
 * cookie/session/membership check instead of a second copy.
 */
export const requireAccountSession = (dependencies: RouteDependencies): RequestHandler => {
  const handler: RequestHandler = async (req, res, next) => {
    try {
      const sessionToken = req.cookies?.[dependencies.env.SESSION_COOKIE_NAME];
      if (typeof sessionToken !== "string" || !sessionToken) {
        throw new HttpError(401, "unauthorized", "Unauthorized");
      }

      const session = await dependencies.authService.authenticateSession(sessionToken);
      await dependencies.accountAccessService.requireActiveMembership(session.accountId, session.userId);
      res.locals.accountId = session.accountId;
      res.locals.userId = session.userId;
      res.locals.sessionId = session.sessionId;
      next();
    } catch (error) {
      next(error);
    }
  };
  return dependencies.apiPrincipalRouteInventory.markAuthenticator(handler, "session_only");
};
