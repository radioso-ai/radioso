import { createHash } from "node:crypto";

import type { AgentToolDescriptor } from "../converseApiAdapter.js";

/**
 * Identifies one exact tool set. Sessions whose catalogs hash alike share one MCP server,
 * so the key covers everything a client can observe about the tools: names, descriptions,
 * schemas, and lineages, in catalog order. The full SHA-256 digest is the key: a
 * collision would hand one session another catalog's tools, so nothing is shaved off it.
 */
export const toToolCatalogKey = (tools: AgentToolDescriptor[]): string =>
  createHash("sha256").update(JSON.stringify(tools)).digest("hex");
