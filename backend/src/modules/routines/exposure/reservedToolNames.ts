/**
 * Tool names the agent-facing MCP surface claims for itself. An exposed routine cannot take
 * one, or `tools/list` would carry two tools with the same name and a calling agent could
 * not tell which one it invoked.
 */
export const reservedRoutineToolNames: ReadonlySet<string> = new Set(["ask_agent", "get_conversation_updates"]);
