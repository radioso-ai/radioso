import { AppsError } from "./errors.js";
import type { AppOperatorAuthorizationPort, AppOperatorPrincipal } from "../ports/operatorAuthorization.js";

/**
 * The request-time reading of an authorization decision: a denial refuses the request, and
 * an indeterminate answer refuses it too, but as a temporary platform condition rather
 * than a statement about the operator. Keeping the two apart matters most inside a saga,
 * where treating a timed-out membership lookup as a revocation would compensate a live
 * installation for no reason.
 */
export const requireAppAdministration = async (
  authorization: AppOperatorAuthorizationPort,
  principal: AppOperatorPrincipal,
  workspaceId: string,
): Promise<void> => {
  const decision = await authorization.authorizeAppAdministration(principal, workspaceId);
  if (decision.ok) return;
  if (decision.outcome === "denied") {
    throw new AppsError(
      "initiating_principal_unauthorized",
      "You do not have permission to administer Apps in this workspace.",
    );
  }
  throw new AppsError(
    "authorization_unavailable",
    "Radioso could not check App administration permission right now. Retry in a moment.",
  );
};
