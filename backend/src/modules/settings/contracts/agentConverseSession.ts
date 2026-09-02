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

/** The converse session flow only needs the bound agent's public identity. */
export interface AgentConverseAgentLookupPort {
  findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<{
    id: string;
    name: string;
  } | null>;
}

/**
 * Persists the conversation identity derived from one active MCP credential
 * version. The exchange service owns the mapping's meaning; storage only
 * provides an atomic get-or-create operation.
 */
export interface AgentConverseSessionMappingPort {
  resolvePublicSessionId(input: {
    grantId: string;
    grantVersion: string;
    proposedPublicSessionId: string;
  }): Promise<string>;
}

/** What the MCP converse HTTP surface needs from the session service. */
export interface AgentConverseSessionPort {
  exchange(input: { launchToken: string; client?: { name?: string; version?: string } }): Promise<AgentConverseSessionExchangeResult>;
  validate(sessionToken: string | undefined): Promise<AgentConversePrincipal>;
  recordSuccessfulUse(principal: Pick<AgentConversePrincipal, "grantId">): void;
  permissions(): string[];
}
