/**
 * Where an agent's public documents live. One place, because three surfaces have to agree:
 * the routes that serve them, the embed launcher's `<link>`, and the MCP server's reserved
 * path next to an endpoint.
 */

/** The A2A Agent Card, scoped to a public id. */
const agentCardPath = (publicId: string): string => `/.well-known/agent-card/${publicId}.json`;

/**
 * The path the MCP server-card extension reserves next to an endpoint. A pure MCP client
 * dereferences this one; the `/.well-known` canonical exists for everything that starts
 * from a hostname instead of from an endpoint.
 */
export const endpointRelativeServerCardUrl = (mcpEndpointUrl: string): string =>
  `${mcpEndpointUrl.replace(/\/+$/u, "")}/server-card`;

/**
 * The per-agent MCP endpoint. The public id is in the path so one URL carries both the
 * address and the identity — which is what makes the endpoint-relative server card and a
 * credential-free connect work from a single string a person can paste.
 */
export const agentMcpEndpointUrl = (mcpBaseUrl: string, publicId: string): string =>
  `${mcpBaseUrl.replace(/\/+$/u, "")}/a/${publicId}`;

/** An absolute card URL for a caller that has a base URL to hang it on. */
export const buildAgentCardUrl = (baseUrl: string, publicId: string): string =>
  new URL(agentCardPath(publicId), baseUrl).toString();
