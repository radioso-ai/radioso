import { RadiosoApiError } from "../radiosoApiAdapter.js";

/** Credential classes understood at the MCP boundary. OAuth is intentionally absent. */
export type McpCredentialClass =
  | "legacy_workspace_api"
  | "personal_api"
  | "service_account_credential"
  | "agent_converse";

export interface McpCredentialPreflight {
  credentialClass?: McpCredentialClass;
}

/**
 * This feature has no MCP authorization for the new API credential classes.
 * Missing class metadata is retained for older backends; those backends must
 * reject the new credentials at their MCP context/auth boundary when upgraded.
 */
export const assertMcpWorkspaceCredential = (
  preflight: McpCredentialPreflight,
): void => {
  if (
    preflight.credentialClass === "personal_api"
    || preflight.credentialClass === "service_account_credential"
  ) {
    throw new RadiosoApiError(
      "MCP access token is invalid or expired.",
      401,
      "invalid_access_token",
    );
  }
};
