type FetchLike = typeof fetch;

export interface AgentServerCardDocument {
  status: number;
  body: unknown;
}

export interface AgentServerCardReader {
  read(publicId: string): Promise<AgentServerCardDocument>;
}

const NOT_FOUND: AgentServerCardDocument = {
  status: 404,
  body: { error: { code: "not_found", message: "Route not found." } },
};

/**
 * Reads one agent's server card from the backend, which is where the card is rendered and
 * cached. The MCP server proxies rather than renders: a second copy of the document shape
 * out here would drift from the one `/.well-known` serves.
 */
export const createAgentServerCardReader = (
  config: { baseUrl: string; requestTimeoutMs: number },
  fetchImpl: FetchLike = fetch,
): AgentServerCardReader => ({
  async read(publicId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetchImpl(
        `${config.baseUrl}/.well-known/mcp/server-card/${encodeURIComponent(publicId)}.json`,
        { method: "GET", headers: { accept: "application/json" }, signal: controller.signal },
      );
      if (!response.ok) {
        // Unknown id, card switched off, unpublished, deleted: the backend answers all of
        // them identically, and so does this.
        return NOT_FOUND;
      }
      return { status: 200, body: await response.json() };
    } catch {
      return {
        status: 502,
        body: { error: { code: "upstream_unavailable", message: "Server card is unavailable." } },
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});
