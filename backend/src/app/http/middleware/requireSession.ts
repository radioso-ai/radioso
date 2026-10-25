import type { NextFunction, Request, RequestHandler, Response } from "express";

import { unauthorized } from "../../../shared/domain/errors.js";
import type { Env } from "../../config/env.js";
import type { AccountAccessService } from "../../../modules/account/services/accountAccessService.js";
import type { AuthService } from "../../../modules/auth/services/authService.js";
import { markApiPrincipalAuthenticator } from "../apiPrincipalRoutePolicy.js";

/**
 * The credential generation `requireSession` read with the live session. A
 * route that writes a new session presents it, so a reset that commits after
 * the session check supersedes the write. Reaching such a route without it is
 * a wiring fault, answered as an internal error rather than as a sign-in refusal.
 */
export const sessionCredentialGeneration = (res: Response): number => {
  const generation: unknown = res.locals.credentialGeneration;
  if (typeof generation === "number" && Number.isInteger(generation)) {
    return generation;
  }
  throw new Error("Session credential generation is missing: mount requireSession before this route");
};

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

  return markApiPrincipalAuthenticator(async (req: Request, res: Response, next: NextFunction) => {
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
      res.locals.credentialGeneration = session.credentialGeneration;
      next();
    } catch (error) {
      next(error);
    }
  }, "session_only");
};
