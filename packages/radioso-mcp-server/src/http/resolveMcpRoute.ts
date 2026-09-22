/**
 * The remote server's routing table as data. Pure, so every path the server answers — and
 * every path it refuses — is decided in one readable place and testable without a socket.
 */
type McpRoute =
  | { kind: "health" }
  | { kind: "agent_mcp" }
  | { kind: "operator_resource_metadata" }
  | { kind: "operator_mcp" }
  | { kind: "agent_server_card"; publicId: string }
  | { kind: "agent_walk_in_mcp"; publicId: string }
  | { kind: "not_found" };

/** Structural bound on the path segment carrying a public agent id. */
const PUBLIC_ID_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * The server-card extension reserves `<endpoint>/server-card`, and an agent's endpoint is
 * `/mcp/a/{publicId}` — so a client that has only the endpoint URL can dereference the card
 * by appending one segment, with no second host and no `.well-known` lookup.
 */
const AGENT_SERVER_CARD = /^\/mcp\/a\/([^/]+)\/server-card$/u;

/**
 * A public agent's own endpoint. It accepts no credential, so a client that has only this
 * URL connects with nothing else; the backend decides whether the agent's door is open.
 */
const AGENT_WALK_IN_MCP = /^\/mcp\/a\/([^/]+)\/?$/u;

export const resolveMcpRoute = (input: {
  method: string;
  pathname: string;
  /** Path of the operator OAuth protected-resource metadata, when the operator surface runs. */
  operatorResourceMetadataPath?: string | null;
}): McpRoute => {
  if (input.method === "GET" && input.pathname === "/healthz") {
    return { kind: "health" };
  }
  if (input.pathname === "/mcp") {
    return { kind: "agent_mcp" };
  }
  if (input.method === "GET" && input.operatorResourceMetadataPath && input.pathname === input.operatorResourceMetadataPath) {
    return { kind: "operator_resource_metadata" };
  }
  if (input.pathname === "/operator/mcp") {
    return { kind: "operator_mcp" };
  }
  const serverCard = input.method === "GET" ? AGENT_SERVER_CARD.exec(input.pathname) : null;
  const cardPublicId = serverCard?.[1];
  if (cardPublicId && PUBLIC_ID_SEGMENT.test(cardPublicId)) {
    return { kind: "agent_server_card", publicId: cardPublicId };
  }
  const walkIn = AGENT_WALK_IN_MCP.exec(input.pathname)?.[1];
  if (walkIn && PUBLIC_ID_SEGMENT.test(walkIn)) {
    return { kind: "agent_walk_in_mcp", publicId: walkIn };
  }
  return { kind: "not_found" };
};
