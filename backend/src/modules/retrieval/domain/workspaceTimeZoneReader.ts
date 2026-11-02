/**
 * Reads the zone a workspace's operators set for relative dates. Retrieval resolves a run's
 * "today" from it when the run arrives without a zone of its own, as Retrieval API, MCP, and
 * routine-step runs do; a chat turn resolves its zone before retrieval and passes it in.
 */
export interface WorkspaceTimeZoneReader {
  /** The stored IANA zone name, or null when the workspace has none. */
  readWorkspaceTimeZone(workspaceId: string): Promise<string | null>;
}
