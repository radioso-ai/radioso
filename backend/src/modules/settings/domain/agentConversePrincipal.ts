import type {
  AgentConverseChannel,
  AgentConverseOrigin,
  AgentConversePrincipal,
} from "../contracts/agentConverseSession.js";

/**
 * The principal a converse turn runs as, from the claims an origin was admitted with, whichever way
 * the door carries them: a signed session token (MCP) or a caller-held opening (A2A). The channel is
 * the door's, so the turn records which one the caller came through.
 */
export const agentConversePrincipal = (
  claims: { workspaceId: string; agentId: string; publicSessionId: string; origin: AgentConverseOrigin },
  sourceChannel: AgentConverseChannel,
): AgentConversePrincipal => ({
  workspaceId: claims.workspaceId,
  agentId: claims.agentId,
  publicSessionId: claims.publicSessionId,
  origin: claims.origin,
  sourceChannel,
  sourceOrigin: null,
  authPrincipal: {
    type: "public_chat_session",
    role: "agent",
    workspaceId: claims.workspaceId,
    agentId: claims.agentId,
    publicSessionId: claims.publicSessionId,
  },
});
