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

/** Where every agent's A2A endpoint sits. One constant, so the URL a card names and the path the router answers cannot differ. */
const A2A_ENDPOINT_PATH_PREFIX = "/a2a";

/**
 * The Express path the A2A endpoint is mounted at. Exported for composition, which owns the
 * mount, so the router and the URL `agentA2aEndpointUrl` builds cannot drift apart.
 */
export const A2A_ENDPOINT_MOUNT_PATH = `${A2A_ENDPOINT_PATH_PREFIX}/:publicId`;

/**
 * The per-agent A2A endpoint, hung on the deployment's public API base. Unlike
 * `buildAgentCardUrl`, this keeps any path the base is served under: behind the dashboard's
 * `/backend` proxy the base is `https://app.example.com/backend`, and resolving an absolute
 * path against it would silently drop that prefix and send callers somewhere that does not
 * answer.
 */
export const agentA2aEndpointUrl = (publicApiBase: string, publicId: string): string =>
  `${publicApiBase.replace(/\/+$/u, "")}${A2A_ENDPOINT_PATH_PREFIX}/${encodeURIComponent(publicId)}`;

/** An absolute card URL for a caller that has a base URL to hang it on. */
export const buildAgentCardUrl = (baseUrl: string, publicId: string): string =>
  new URL(agentCardPath(publicId), baseUrl).toString();
