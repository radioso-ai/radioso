import type { NextFunction, Request, RequestHandler, Response } from "express";

import { unauthorized } from "../../../shared/domain/errors.js";
import type { AuthService } from "../../../modules/auth/services/authService.js";
import { allowsMachinePrincipal, markApiPrincipalAuthenticator } from "../apiPrincipalRoutePolicy.js";
import { attributeMachinePrincipalToRequestAudit } from "./requestAuditContextMiddleware.js";
import type { MachineAccessSecurityObserver } from "../../../modules/machineAccess/public.js";
import { onSuccessfulHttpResponse } from "./httpResponseCompletion.js";

export interface ApiTokenDependencies {
  authService: Pick<AuthService, "authenticateApiToken" | "recordApiTokenUse">;
  machineAccessSecurityObserver?: Pick<MachineAccessSecurityObserver, "recordAuthorizationDenial">;
}

export const requireApiToken = (dependencies: ApiTokenDependencies): RequestHandler => {
  return markApiPrincipalAuthenticator(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authorization = req.header("authorization");

      if (!authorization?.startsWith("Bearer ")) {
        next(unauthorized());
        return;
      }

      const token = authorization.slice("Bearer ".length);
      const session = await dependencies.authService.authenticateApiToken(token);
      if (!allowsMachinePrincipal(req.method, `${req.baseUrl}${req.path}`, session.principal)) {
        dependencies.machineAccessSecurityObserver?.recordAuthorizationDenial({
          principalKind: session.principal.type === "personal_api_credential" ? "personal" : "service",
          reason: "route_policy",
        });
        next(unauthorized());
        return;
      }
      res.locals.workspaceId = session.workspaceId;
      res.locals.accountId = session.accountId;
      res.locals.authMode = "bearer";
      res.locals.authPrincipal = session.principal;
      attributeMachinePrincipalToRequestAudit(session.principal);
      onSuccessfulHttpResponse(res, () => dependencies.authService.recordApiTokenUse(session.principal));
      next();
    } catch (error) {
      next(error);
    }
  }, "machine_required");
};
