import { createHash } from "node:crypto";

import type { AgentToolDescriptor } from "../converseApiAdapter.js";

/**
 * Identifies one exact tool set. Sessions whose catalogs hash alike share one MCP server,
 * so the key covers everything a client can observe about the tools: names, descriptions,
 * schemas, and lineages, in catalog order. The full SHA-256 digest is the key: a
 * collision would hand one session another catalog's tools, so nothing is shaved off it.
 *
 * `ask_agent`'s composed description is part of that observable surface and names the agent, so it
 * is part of the key. Without it two agents that expose no routines both hash to the empty tool
 * list — the common case, not an edge one — and the second would be served the first's description.
 */
export const toToolCatalogKey = (tools: AgentToolDescriptor[], askAgentDescription?: string): string =>
  createHash("sha256").update(JSON.stringify([tools, askAgentDescription ?? null])).digest("hex");
