import type { AuthenticatedPrincipal } from "../../account/public.js";

export interface AgentConversePrincipal {
  workspaceId: string;
  agentId: string;
  publicSessionId: string;
  grantId: string;
  grantVersion: string;
  sourceChannel: "mcp";
  sourceOrigin: null;
  authPrincipal: AuthenticatedPrincipal;
}

export interface AgentConverseSessionExchangeResult extends AgentConversePrincipal {
  sessionToken: string;
  expiresAt: string;
  agent: {
    id: string;
    name: string;
  };
}

/** What the MCP converse HTTP surface needs from the session service. */
export interface AgentConverseSessionPort {
  exchange(input: { launchToken: string; client?: { name?: string; version?: string } }): Promise<AgentConverseSessionExchangeResult>;
  validate(sessionToken: string | undefined): Promise<AgentConversePrincipal>;
  permissions(): string[];
}
