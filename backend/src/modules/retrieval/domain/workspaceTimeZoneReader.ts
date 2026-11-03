/**
 * Reads the zone a workspace's operators set for relative dates. A chat turn, live or replayed,
 * reads it when its visitor reports no zone; retrieval reads it when a run arrives without a zone
 * of its own, as Retrieval API and MCP runs do.
 */
export interface WorkspaceTimeZoneReader {
  /** The stored IANA zone name, or null when the workspace has none. */
  readWorkspaceTimeZone(workspaceId: string): Promise<string | null>;
}
