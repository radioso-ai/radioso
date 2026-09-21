import { createHash } from "node:crypto";

import type { AgentToolDescriptor } from "../converseApiAdapter.js";

/**
 * Identifies one exact tool set. Sessions whose catalogs hash alike share one MCP server,
 * so the key covers everything a client can observe about the tools: names, descriptions,
 * schemas, and lineages, in catalog order.
 */
export const toToolCatalogKey = (tools: AgentToolDescriptor[]): string =>
  createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 16);
