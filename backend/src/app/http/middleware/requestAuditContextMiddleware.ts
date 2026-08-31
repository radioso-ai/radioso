import type { RequestHandler } from "express";

import {
  runWithRequestAuditContext,
  setRequestAuditPrincipal,
} from "../../../shared/observability/requestAuditContext.js";
import type { AuthenticatedPrincipal } from "../../../modules/account/public.js";

export const createRequestAuditContextMiddleware = (): RequestHandler => (req, _res, next) => {
  const value = (req as { id?: unknown }).id;
  const requestId = (typeof value === "string" && value.length > 0) || typeof value === "number"
    ? String(value)
    : undefined;
  runWithRequestAuditContext({ requestId }, next);
};

export const attributeMachinePrincipalToRequestAudit = (
  principal: AuthenticatedPrincipal,
): void => {
  if (principal.type === "personal_api_credential") {
    setRequestAuditPrincipal({
      credentialId: principal.credentialId,
      principalId: principal.userId,
      principalKind: "user",
      role: principal.role,
    });
  } else if (principal.type === "service_account_credential") {
    setRequestAuditPrincipal({
      credentialId: principal.credentialId,
      principalId: principal.serviceAccountId,
      principalKind: "service",
      role: principal.role,
    });
  }
};
