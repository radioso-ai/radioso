import type { AuthenticatedPrincipal } from "../../modules/account/services/accountAccessService.js";

/** REST API credentials have no MCP authorization contract in this feature. */
export const isApiPrincipalRejectedByMcp = (principal: AuthenticatedPrincipal): boolean =>
  principal.type === "personal_api_credential"
  || principal.type === "service_account_credential";
