import type { NextFunction, Request, RequestHandler, Response } from "express";

import { unauthorized } from "../../../shared/domain/errors.js";
import type { AppDependencies } from "../../server/types.js";

const WORKSPACE_HEADER = "x-workspace-id";
const isBearerAuthorization = (value: string | undefined): boolean =>
  typeof value === "string" && /^bearer(?:\s|$)/i.test(value.trim());

export type DashboardWorkspaceSessionDependencies = Pick<
  AppDependencies,
  "env" | "authService" | "accountAccessService" | "workspaceSessionService"
>;

/**
 * Dashboard-only workspace authentication. It deliberately has no bearer fallback:
 * routes using it must reject API tokens before permission, rate-limit, or service work.
 */
export const requireDashboardWorkspaceSession = (
  dependencies: DashboardWorkspaceSessionDependencies,
): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authorization = req.header("authorization");
      if (isBearerAuthorization(authorization)) {
        next(unauthorized());
        return;
      }
      const sessionToken = req.cookies?.[dependencies.env.SESSION_COOKIE_NAME];
      if (!sessionToken) {
        next(unauthorized());
        return;
      }
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
    } catch (error) {
      next(error);
    }
  };
};
