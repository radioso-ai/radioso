import { createHash } from "node:crypto";

import type { AgentToolDescriptor } from "../converseApiAdapter.js";

/**
 * Identifies one exact tool set, covering everything a client can observe about the session's
 * tools: names, descriptions, schemas, lineages in catalog order, and the composed `ask_agent`
 * description. The full SHA-256 digest is the key, with nothing shaved off it.
 *
 * `sessionServerManager` builds a server per request from `session.toolCatalog`, so nothing reads
 * this key today — it identifies a catalog for a sharing scheme that does not exist yet. Keep it
 * covering the whole observable surface anyway: a key that omits part of what a client sees is only
 * safe for as long as it stays unused, and two agents exposing no routines already hash alike on
 * their tool lists alone.
 */
export const toToolCatalogKey = (tools: AgentToolDescriptor[], askAgentDescription?: string): string =>
  createHash("sha256").update(JSON.stringify([tools, askAgentDescription ?? null])).digest("hex");
