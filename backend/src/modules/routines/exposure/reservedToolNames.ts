/**
 * Tool names the agent-facing MCP surface claims for itself. An exposed routine cannot take
 * one, or `tools/list` would carry two tools with the same name and a calling agent could
 * not tell which one it invoked.
 *
 * Source of truth: the static tools `packages/radioso-mcp-server/src/server.ts` registers
 * (`ask_agent` from `tools/converseTools.ts`, `radioso_docs` and `radioso_doc_page` from
 * `tools/productDocsTools.ts`) plus `get_conversation_updates`, the resumption tool the
 * package adds with US5. The backend does not depend on the package, so the list is kept
 * by hand; the package filters a collision defensively (`withoutStaticNameCollisions`).
 */
export const reservedRoutineToolNames: ReadonlySet<string> = new Set([
  "ask_agent",
  "get_conversation_updates",
  "radioso_docs",
  "radioso_doc_page",
]);
