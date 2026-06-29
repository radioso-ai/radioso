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
